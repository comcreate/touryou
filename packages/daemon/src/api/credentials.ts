/**
 * 窓口の認証情報。人間（画面・コマンド）の資格情報と、ノード専用のトークン（MCP）を分ける（NFR_004）。
 * 呼び出したロールとノードは、要求の本文の申告ではなく、このトークンから決める。
 *
 * - トークンそのものは保持せず、SHA-256 のハッシュだけを持つ。照合は定数時間で行う。
 * - ノードのトークンは、ノードごとに 1 つ。再発行すると古いものは無効になる。`revokeNode` で失効させる。
 * - 未知・不正なトークンは認証しない（フェイルクローズ）。
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { RevokedStore } from "./revoked-store.js";
import type { TokenRepository } from "./token-repository.js";

export type Principal =
  | {
      readonly role: "human";
      /** 画面のセッションのトークンで認証した（`human-token` でない）。ログで見分けるための印で、権限は変わらない。 */
      readonly via?: "uiSession";
    }
  | { readonly role: "integrator" | "child"; readonly nodeId: string };

export type NodeRoleForToken = "integrator" | "child";

/** トークンの期限。値はミリ秒。 */
export interface TokenExpiry {
  /** daemon が起動する子（`sdk`）の、使わなければ切れる期限。既定 6 時間。 */
  readonly sdkIdleMs: number;
  /**
   * `sdk` の、発行からのゆるい絶対の期限（既定 7 日）。起動し直しで使わなかった時間を数え直しても、ずっと生き続けないように。
   * 省略すると既定（古い呼び出し元のため）。
   */
  readonly sdkAbsoluteMs?: number;
  /** 紐付け（`bind`。Desktop の子）の、発行からの絶対の期限。既定 24 時間。 */
  readonly bindAbsoluteMs: number;
  /** 紐付け（`bind`）の、使わなければ切れる期限。既定 1 時間。 */
  readonly bindIdleMs: number;
}
export const DEFAULT_TOKEN_EXPIRY: TokenExpiry = {
  sdkIdleMs: 6 * 3_600_000,
  sdkAbsoluteMs: 7 * 24 * 3_600_000,
  bindAbsoluteMs: 24 * 3_600_000,
  bindIdleMs: 3_600_000,
};
const DEFAULT_SDK_ABSOLUTE_MS = 7 * 24 * 3_600_000;
/** 最後に使った時刻を、保存先へ書く間隔の下限（1 ノードにつき）。 */
export const LAST_USED_WRITE_MS = 60_000;

/** 期限切れ・役目の終わりで失効させた理由。 */
export type ExpiryReason = "absolute" | "idle" | "retired";

export type TokenKind = "sdk" | "bind";

export interface CredentialStore {
  authenticate(token: unknown): Principal | undefined;
  /** 直近に期限切れ・役目の終わりで失効させたトークンか（応答の失敗の記号を tokenExpired にするため。メモリだけ）。 */
  wasExpired?(token: unknown): boolean;
  /**
   * 役目の終わり（`retired`）で失効させたトークンか（記録の `apiAuthFailed` を `retiredExpired` と分けるため。メモリだけ。
   * 起動し直しのあとは分からず、`false`）。
   */
  wasRetired?(token: unknown): boolean;
  /** 期限・役目の終わりを見回り、失効させる（定期の見回り）。失効させたノードの ID。 */
  sweepExpired?(): string[];
  /**
   * そのノードのトークンを、役目の終わりとして失効させる（止まった子）。`revokeNode` と違い、その後の呼び出しは
   * tokenExpired になる。トークンがなければ何もしない（false）。
   */
  expireNode?(nodeId: string): boolean;
  /** そのノードのトークンを使ったものとして数える（フックの呼び出し・道具の使用）。 */
  touchNode?(nodeId: string): void;
  /** ノード専用のトークンを発行する（そのノードの既存のトークンは無効になる）。`kind` の既定は `sdk`。 */
  issueNodeToken(nodeId: string, role: NodeRoleForToken, kind?: TokenKind): string;
  revokeNode(nodeId: string): void;
  /** トークンを持つノードの ID（起動時に、ストアにないノードのトークンを掃除するのに使う）。 */
  nodeIds(): string[];
  /** そのノードが、紐付け（`POST /v1/bind`）で受け取った有効なトークンを持つか（偽の「紐付けをやり直して」を出さないため）。 */
  hasBindToken?(nodeId: string): boolean;
}

export const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{16,512}$/;
const MIN_HUMAN_TOKEN = 32;

/** `Authorization: Bearer <token>` からトークンを取り出す。形が違えば `undefined`。 */
export function parseBearer(header: unknown): string | undefined {
  if (typeof header !== "string") return undefined;
  const m = /^Bearer ([^ ]+)$/.exec(header);
  const token = m?.[1];
  return token !== undefined && TOKEN_SHAPE.test(token) ? token : undefined;
}

/** 人間のトークンを生成する（`randomBytes(32).base64url` に固定。43 文字）。 */
export const generateHumanToken = (): string => randomBytes(32).toString("base64url");

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

export function createCredentialStore(options: {
  readonly humanToken: string;
  /** テスト用。既定は `crypto.randomBytes`。 */
  readonly randomBytes?: (size: number) => Buffer;
  /** ノードのトークンの保存先。省略するとメモリ上だけ（再起動で無効になる）。 */
  readonly repository?: TokenRepository;
  /**
   * 失効させたトークンの印の保存先。省略するとメモリ上だけ（再起動で `wasExpired` が false に戻る）。
   * 渡すと、起動し直しのあとも、失効済みのトークンを expired と返す（トークンの最長の期限まで）。
   */
  readonly revokedStore?: RevokedStore;
  /** 発行日時（ISO 8601 UTC）。既定は現在時刻。 */
  readonly clock?: () => string;
  /**
   * ノードのトークンを発行し直した・失効させた直後に呼ぶ（フックの受け口の session_id の結び付けを外す）。
   * 古いトークンを無効にしたあと、同じ同期の処理の中で呼ぶ。これだけでは、認証を済ませて本文を読んでいる途中の古い要求が、
   * 外したあとに結んでしまいうるので、受け口は、結ぶ直前に、もう一度認証する（`server.ts` の `handleHook`）。
   * 両方で、古いトークンの要求は、発行し直したあとに結び付けを作れない。
   */
  readonly onNodeTokenChanged?: (nodeId: string) => void;
  /** 期限。省略すると既定。 */
  readonly expiry?: TokenExpiry;
  /** 期限を付けないノード（根）。 */
  readonly exemptNodeId?: string;
  /** 壁時計（ミリ秒）。起動時の基準と、保存した時刻の読み直しに使う。 */
  readonly nowMs?: () => number;
  /**
   * 単調時計（ミリ秒）。動いている間の経過は、これで数える（壁時計が巻き戻っても、期限が延びない）。
   * 省略すると `nowMs`（試験で時計を差し込むとき）、それもなければ `performance.now`。
   */
  readonly monoMs?: () => number;
  /** 使わなければ切れる時計を止めるノードか（判断待ち・done の子）。bind の絶対の期限は止めない。 */
  readonly isIdlePaused?: (nodeId: string) => boolean;
  /** そのノードのトークンが、もう要らないか（verified・reclaimable・archived、CLI の子なら停止など）。 */
  readonly isRetired?: (nodeId: string, kind: TokenKind) => boolean;
  /** 期限切れ・役目の終わりで失効させたとき（受信箱への知らせなど）。`issuedAt` は、同じトークンを見分けるのに使う。 */
  readonly onExpired?: (
    nodeId: string,
    reason: ExpiryReason,
    kind: TokenKind,
    issuedAt: string,
  ) => void;
}): CredentialStore {
  if (typeof options.humanToken !== "string" || options.humanToken.length < MIN_HUMAN_TOKEN) {
    throw new RangeError(`人間のトークンは ${MIN_HUMAN_TOKEN} 文字以上が必要`);
  }
  const random = options.randomBytes ?? randomBytes;
  const humanHash = sha256(options.humanToken);
  /** ハッシュ（16 進）→ 主体。 */
  const byHash = new Map<string, Principal>();
  /** nodeId → 現在のトークンのハッシュ。 */
  const byNode = new Map<string, string>();
  /** nodeId → 期限の情報（発行・最後に使った時刻〔ミリ秒〕、保存先へ最後に書いた時刻）。 */
  const meta = new Map<
    string,
    {
      kind: TokenKind;
      role: NodeRoleForToken;
      issuedAt: string;
      issuedMs: number;
      lastUsedMs: number;
      writtenMs: number;
    }
  >();
  /**
   * 失効させたトークンのハッシュ → 最長の期限（ミリ秒）。応答で tokenExpired にする。保存先（`revokedStore`）があれば、
   * 起動時に読み戻して、起動し直しのあとも expired と返す。上限つき。
   */
  const expiredHashes = new Map<string, number>();
  const EXPIRED_MAX = 1000;
  /** 役目の終わりで失効させたトークンのハッシュ（メモリだけ。`expiredHashes` から落ちたら、こちらも落とす）。 */
  const retiredHashes = new Set<string>();
  const revokedStore = options.revokedStore;
  const repository = options.repository;
  const clock = options.clock ?? (() => new Date().toISOString());
  // 今の時刻 = 起動時の壁時計 + 単調時計の経過。
  const wallMs = options.nowMs ?? Date.now;
  const mono = options.monoMs ?? options.nowMs ?? (() => performance.now());
  const wall0 = wallMs();
  const mono0 = mono();
  const nowMs = (): number => wall0 + (mono() - mono0);
  const expiry = options.expiry ?? DEFAULT_TOKEN_EXPIRY;
  const parseMs = (iso: string | undefined, fallback: number): number => {
    const t = iso === undefined ? Number.NaN : Date.parse(iso);
    return Number.isNaN(t) ? fallback : t;
  };
  // 保存済みのトークンを復元する（壊れたファイルなどは例外。黙って捨てない）。
  for (const r of repository?.load() ?? []) {
    byHash.set(r.tokenHash, { role: r.role, nodeId: r.nodeId });
    byNode.set(r.nodeId, r.tokenHash);
    // 発行の時刻が読めない記録は、読んだ時刻を発行にしない（起動し直すたびに絶対の期限が延びる）。
    // 保存の検査で issuedAt は必ずあるので、ここに来るのは壊れた値だけ。失効の側（いちばん古い時刻）に倒す。
    const issuedMs = parseMs(r.issuedAt, 0);
    // 使わなかった時間は、起動の時刻から数え直す（daemon が止まっていた間は、子が使えなかった時間なので数えない）。
    // 経過は単調時計で数える（`nowMs` は起動時の壁時計 + 単調時計の経過）。bind の絶対の期限は、発行の時刻のまま。
    const lastUsedMs = nowMs();
    meta.set(r.nodeId, {
      // 版 1（種類がない）は、厳しい側の bind とみなす（発行から 24 時間。どの子のものか分からないため）
      kind: r.kind ?? "bind",
      role: r.role,
      issuedAt: r.issuedAt,
      issuedMs,
      lastUsedMs,
      writtenMs: lastUsedMs,
    });
  }
  // 失効させたトークンの印を読み戻す（起動し直しのあとも expired と返す）。期限を過ぎた印は、保存先が落とす。
  if (revokedStore !== undefined) {
    for (const [h, exp] of revokedStore.load()) expiredHashes.set(h, exp);
  }
  /** トークンの最長の期限（ミリ秒。壁時計）。失効の印を、この時刻まで残す。 */
  const maxExpiryMs = (kind: TokenKind, issuedMs: number): number =>
    issuedMs +
    (kind === "bind" ? expiry.bindAbsoluteMs : (expiry.sdkAbsoluteMs ?? DEFAULT_SDK_ABSOLUTE_MS));
  /** 期限切れ・役目の終わりなら、その理由。 */
  const expiredReason = (nodeId: string, now: number): ExpiryReason | undefined => {
    if (nodeId === options.exemptNodeId) return undefined;
    const m = meta.get(nodeId);
    if (m === undefined) return undefined;
    if (options.isRetired?.(nodeId, m.kind) === true) return "retired";
    // 判断待ち・done のあいだは、使ったものとして数える（使わなければ切れる時計を進めない）
    if (options.isIdlePaused?.(nodeId) === true) m.lastUsedMs = Math.max(m.lastUsedMs, now);
    if (m.kind === "bind") {
      if (now - m.issuedMs >= expiry.bindAbsoluteMs) return "absolute";
      if (now - m.lastUsedMs >= expiry.bindIdleMs) return "idle";
      return undefined;
    }
    if (now - m.issuedMs >= (expiry.sdkAbsoluteMs ?? DEFAULT_SDK_ABSOLUTE_MS)) return "absolute";
    return now - m.lastUsedMs >= expiry.sdkIdleMs ? "idle" : undefined;
  };
  /** 期限切れで失効させる（今の revoke と同じ流れ。フック用も onNodeTokenChanged で一緒に無効）。 */
  const expire = (nodeId: string, reason: ExpiryReason): void => {
    const h = byNode.get(nodeId);
    const m = meta.get(nodeId);
    if (h === undefined || m === undefined) return;
    repository?.remove(nodeId);
    byHash.delete(h);
    byNode.delete(nodeId);
    meta.delete(nodeId);
    // 失効の印を、トークンの最長の期限まで残す（保存先があれば、起動し直しのあとも expired と返す）。
    const expiresMs = maxExpiryMs(m.kind, m.issuedMs);
    expiredHashes.set(h, expiresMs);
    if (expiredHashes.size > EXPIRED_MAX) {
      // 期限の早い順に落とす（遅いものほど、まだ悪用されうるので残す）。
      let earliest: string | undefined;
      let earliestMs = Number.POSITIVE_INFINITY;
      for (const [hash, exp] of expiredHashes) {
        if (exp < earliestMs) {
          earliestMs = exp;
          earliest = hash;
        }
      }
      if (earliest !== undefined) {
        expiredHashes.delete(earliest);
        retiredHashes.delete(earliest);
      }
    }
    if (reason === "retired") retiredHashes.add(h);
    else retiredHashes.delete(h);
    try {
      revokedStore?.add(h, expiresMs);
    } catch {
      // 保存に失敗しても、失効そのものは成り立つ（メモリの印は残る。次の起動で復元できないだけ）。
    }
    options.onNodeTokenChanged?.(nodeId);
    options.onExpired?.(nodeId, reason, m.kind, m.issuedAt);
  };
  /** 最後に使った時刻を更新し、保存先へは 1 ノードにつき LAST_USED_WRITE_MS に 1 回まで書く。 */
  const touch = (nodeId: string, h: string, now: number): void => {
    const m = meta.get(nodeId);
    if (m === undefined) return;
    m.lastUsedMs = Math.max(m.lastUsedMs, now);
    if (repository === undefined || now - m.writtenMs < LAST_USED_WRITE_MS) return;
    try {
      repository.put({
        tokenHash: h,
        role: m.role,
        nodeId,
        issuedAt: m.issuedAt,
        lastUsedAt: new Date(m.lastUsedMs).toISOString(),
        kind: m.kind,
      });
      m.writtenMs = now;
    } catch {
      // 書けなくても認証は続ける（次の機会に書く。daemon が落ちれば、古い時刻が残る＝期限が早く来る側）
    }
  };

  return {
    authenticate(token) {
      if (typeof token !== "string" || token === "") return undefined;
      const h = sha256(token);
      if (timingSafeEqual(h, humanHash)) return { role: "human" };
      const hex = h.toString("hex");
      const p = byHash.get(hex);
      if (p === undefined || p.role === "human") return p;
      const now = nowMs();
      const reason = expiredReason(p.nodeId, now);
      if (reason !== undefined) {
        expire(p.nodeId, reason);
        return undefined;
      }
      touch(p.nodeId, hex, now);
      return p;
    },
    wasExpired(token) {
      if (typeof token !== "string" || token === "") return false;
      const exp = expiredHashes.get(sha256(token).toString("hex"));
      if (exp === undefined) return false;
      // 最長の期限を過ぎた印は落とす（時間だけで expired になるので、残す必要がない）。
      if (exp <= nowMs()) {
        expiredHashes.delete(sha256(token).toString("hex"));
        retiredHashes.delete(sha256(token).toString("hex"));
        return false;
      }
      return true;
    },
    wasRetired(token) {
      if (typeof token !== "string" || token === "") return false;
      const hex = sha256(token).toString("hex");
      return retiredHashes.has(hex) && expiredHashes.has(hex);
    },
    expireNode(nodeId) {
      if (nodeId === options.exemptNodeId || !byNode.has(nodeId)) return false;
      expire(nodeId, "retired");
      return true;
    },
    touchNode(nodeId) {
      const h = byNode.get(nodeId);
      if (h === undefined) return;
      const now = nowMs();
      if (expiredReason(nodeId, now) !== undefined) return; // 切れたものは延ばさない（次の認証・見回りで失効）
      touch(nodeId, h, now);
    },
    sweepExpired() {
      const now = nowMs();
      const out: string[] = [];
      for (const nodeId of [...byNode.keys()]) {
        const reason = expiredReason(nodeId, now);
        if (reason === undefined) continue;
        expire(nodeId, reason);
        out.push(nodeId);
      }
      return out;
    },
    issueNodeToken(nodeId, role, kind = "sdk") {
      if (typeof nodeId !== "string" || nodeId === "") throw new RangeError("nodeId が不正");
      if (role !== "integrator" && role !== "child") throw new RangeError("ロールが不正");
      const old = byNode.get(nodeId);
      const token = random(32).toString("base64url");
      const h = sha256(token).toString("hex");
      // 保存に成功してから有効にする（失敗したら例外で、トークンは発行されず、古いトークンも残る）。
      const issuedAt = clock();
      repository?.put({ tokenHash: h, role, nodeId, issuedAt, lastUsedAt: issuedAt, kind });
      if (old !== undefined) byHash.delete(old);
      byHash.set(h, { role, nodeId });
      byNode.set(nodeId, h);
      const now = nowMs();
      meta.set(nodeId, { kind, role, issuedAt, issuedMs: now, lastUsedMs: now, writtenMs: now });
      options.onNodeTokenChanged?.(nodeId);
      return token;
    },
    nodeIds: () => [...byNode.keys()],
    hasBindToken: (nodeId) => byNode.has(nodeId) && meta.get(nodeId)?.kind === "bind",
    revokeNode(nodeId) {
      const h = byNode.get(nodeId);
      if (h === undefined) return;
      // 保存先から消せなかったら例外（メモリ上も残す。失効できていないことを、呼び出し側が知れる）。
      repository?.remove(nodeId);
      byHash.delete(h);
      byNode.delete(nodeId);
      meta.delete(nodeId);
      options.onNodeTokenChanged?.(nodeId);
    },
  };
}
