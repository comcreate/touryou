/**
 * 状態画面を、作り物の記録（種）で、手元のブラウザに出す（手で見る確かめ用。docs/ui.md の「手元で見る」）。
 *
 * 前提: `pnpm install && pnpm build` 済み。`packages/daemon/dist` の本物の API サーバー（画面の資産・`/ui/graph.js`・
 * `/v1/ui/state`・`/v1/events`）を、一時の stateDir と 127.0.0.1 の空いたポートで立てる。
 * 常駐している本物の daemon には触らない（stateDir・ポート・トークンを分け、`$HOME/.touryou` を読まない・書かない）。
 *
 * 使い方: node scripts/ui-preview.mjs [--no-open] [--live]
 *   --no-open  ブラウザを開かない（開かなかった旨と、チケットを含まない URL だけを出す）
 *   --live     数秒ごとに作り物のやり取りを 1 つ足し、段を sent → delivered → done と進める
 * Ctrl+C で止めると、一時の stateDir を消す。
 *
 * 画面の操作（答え・承認など）は、どれも「ui-preview は見るための道具なので、操作は試せません」で断る。
 * 試験だけ、TOURYOU_PREVIEW_TOKEN で自分のトークンを渡せる（入れるだけで、出さない）。
 * トークン・チケットは、画面・ログ・引数に出さない（チケットは `touryou ui` と同じく `/usr/bin/open` の引数にだけ渡す）。
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = "使い方: node scripts/ui-preview.mjs [--no-open] [--live]\n";
const args = process.argv.slice(2);
for (const a of args) {
  if (a !== "--no-open" && a !== "--live") {
    process.stderr.write(`知らない引数です。${USAGE}`);
    process.exit(2);
  }
}
const OPEN = !args.includes("--no-open");
const LIVE = args.includes("--live");
const LIVE_MS_RAW = Number(process.env.TOURYOU_PREVIEW_LIVE_MS ?? "3000");
// 数でない・小さすぎる値は、既定に戻す（1 ミリ秒ごとに回らないように）
const LIVE_MS = Number.isFinite(LIVE_MS_RAW) && LIVE_MS_RAW >= 50 ? LIVE_MS_RAW : 3000;

const R = join(dirname(fileURLToPath(import.meta.url)), "..", "packages");
let core;
let api;
let creds;
try {
  core = await import(`${R}/core/dist/index.js`);
  api = await import(`${R}/daemon/dist/api/server.js`);
  creds = await import(`${R}/daemon/dist/api/credentials.js`);
} catch {
  process.stderr.write(
    "packages の dist がありません。先に pnpm install && pnpm build を実行してください。\n",
  );
  process.exit(1);
}

// --- 種（起動のときの今を基準にした時刻）。本物の daemon と同じく、イベントの列を foldEvents で畳む ---
const NOW = Date.now();
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const XSS = '<script>alert("xss")</script><img src=x onerror="alert(1)">';
const SYSTEM = { system: true };
const HUMAN = { human: true };
const by = (nodeId) => ({ nodeId });

let seq = 0;
const events = [];
const ev = (at, actor, type, payload) => {
  seq += 1;
  events.push({ seq, at, requestId: `preview-${seq}`, actor, type, payload });
  return seq;
};
const brief = (objective) => ({
  objective,
  acceptanceCriteria: ["見本どおりに見える"],
  scope: { writableLocations: ["src"], forbiddenLocations: [], allowedCommands: ["pnpm test"] },
});
const create = (at, nodeId, role, parentId, objective) => {
  ev(at, SYSTEM, "node.created", { nodeId, role, parentId, dependsOn: [], ...brief(objective) });
  ev(at, SYSTEM, "node.stateChanged", { nodeId, event: { type: "start" } });
};
const change = (at, nodeId, event, actor = SYSTEM) =>
  ev(at, actor, "node.stateChanged", { nodeId, event });
const instruct = (at, deliveredAt, nodeId, actor, text = "追加の指示", kind) => {
  const s = ev(at, actor, "node.instructed", {
    nodeId,
    text,
    ...(kind === undefined ? {} : { kind }),
  });
  if (deliveredAt !== undefined)
    ev(deliveredAt, SYSTEM, "node.instructionDelivered", { nodeId, instructedSeq: s });
  return s;
};
const report = (at, nodeId, kind, text = "報告") =>
  ev(at, by(nodeId), "report.added", { reportId: `rep-${seq + 1}`, nodeId, kind, text });
const item = (at, nodeId, kind, summary) =>
  ev(at, SYSTEM, "inbox.added", { id: `in-${seq + 1}`, kind, nodeId, summary });

// 古いもの（1 時間より前）から新しいもの（5 分以内）へ
create(ago(150), "root", "integrator", null, "v0.1.4 の公開に向けた統合");
create(
  ago(150),
  "c1",
  "integrator",
  "root",
  "状態画面の関係図を、見本の v8 の形にそろえ、箱・線・札・凡例の描き方を整え、狭い窓でも崩れないようにする（長い題の見え方の確かめ）",
);
create(ago(150), "c2", "investigate", "root", "調べ: SSE の枠");
create(ago(150), "c3", "integrator", "root", "CLI の子の探すコマンド");
create(ago(150), "c4", "review", "root", "レビュー");
create(ago(150), "c5", "integrator", "root", "配布物の確かめを直す");
// 片付け済みの孫（済んだ → 受け入れた → アーカイブ）
create(ago(140), "g4", "implement", "c5", "片付け済みの作業");
instruct(ago(130), ago(129), "g4", by("c5"));
report(ago(125), "g4", "done");
change(ago(125), "g4", { type: "reportDone" }, by("g4"));
change(ago(122), "g4", { type: "accept" }, by("c5"));
change(ago(121), "g4", { type: "markReclaimable", discarded: false });
change(ago(120), "g4", { type: "archive" });

instruct(ago(95), ago(94), "c1", by("root"), "関係図を見本にそろえる");
report(ago(90), "c1", "progress");
item(ago(90), "c1", "progress", `箱の形を直しています ${XSS}`);
create(ago(85), "g1", "implement", "c1", "線の札の時刻");
create(ago(85), "g2", "implement", "c1", "凡例");
create(ago(85), "g6", "implement", "c1", "線の太さ");
create(ago(85), "g3", "investigate", "c3", "古い調べ（止めた）");
create(ago(85), "g5", "implement", "c3", "止まり切らない子（停止の代行依頼）");
instruct(ago(80), ago(79), "c3", by("root"));
instruct(ago(75), ago(74), "g3", by("c3"));
report(ago(72), "g3", "progress");
change(ago(71), "g3", { type: "stop", mode: "immediate" }, by("c3"));
change(ago(71), "g3", { type: "confirmStopped" });
report(ago(70), "c3", "progress");
// 人の答えた判断（下りの答え）
ev(ago(65), by("c2"), "decision.requested", {
  decisionId: "d-old",
  nodeId: "c2",
  question: "どちらの枠の数にしますか",
  options: ["4 本", "8 本"],
});
ev(ago(60), HUMAN, "decision.answered", { decisionId: "d-old", answer: "4 本" });
report(ago(55), "c2", "progress");
// 却下した範囲の頼み
ev(ago(50), by("c3"), "scope.extensionRequested", {
  extensionId: "x-old",
  nodeId: "c3",
  target: { kind: "command", value: "rm -rf build" },
  reason: "古い成果物を消したい",
});
ev(ago(48), HUMAN, "scope.extensionDecided", { extensionId: "x-old", decision: "reject" });
// 判定を子に届ける追加指示（#116 の kind）。図では、親から子への下りの線の札「→ 却下」になる
instruct(ago(48), ago(47), "c3", HUMAN, "範囲の頼みは却下された", "extensionRejected");
// 孫の範囲の頼みを許可した（親 c1 から孫 g1 への下りの線の札「→ 許可」）
ev(ago(34), by("g1"), "scope.extensionRequested", {
  extensionId: "x-ok",
  nodeId: "g1",
  target: { kind: "command", value: "pnpm lint" },
  reason: "書式を確かめたい",
});
ev(ago(33), HUMAN, "scope.extensionDecided", {
  extensionId: "x-ok",
  decision: "approve",
  granted: { kind: "command", value: "pnpm lint" },
});
instruct(ago(33), ago(32), "g1", HUMAN, "範囲の頼みは許可された", "extensionApproved");
instruct(ago(45), ago(44), "c4", by("root"), "PR を見る");
instruct(ago(40), ago(39), "g1", by("c1"));
instruct(ago(38), ago(37), "g2", by("c1"));
instruct(ago(36), ago(35), "g6", by("c1"));
report(ago(35), "g1", "progress");
instruct(ago(30), ago(29), "c5", HUMAN, "人からの指示");
report(ago(25), "g2", "done");
change(ago(25), "g2", { type: "reportDone" }, by("g2"));
change(ago(20), "g2", { type: "accept" }, by("c1"));
report(ago(15), "c5", "failure", "試験が落ちた");
item(ago(15), "c5", "failure", `試験が落ちました: ${XSS}`);
item(ago(12), "c4", "info", core.stallSummary("c4", 30));
change(ago(10), "g5", { type: "stop", mode: "immediate" }, by("c3"));
change(ago(10), "g5", { type: "stopTimeout" });
item(ago(10), "g5", "stopIncomplete", "止めたが、まだ動いている");
report(ago(8), "g1", "done");
change(ago(8), "g1", { type: "reportDone" }, by("g1"));
item(ago(8), "g1", "done", "線の札の時刻を足しました");
// 答え待ち（判断の頼み・範囲の頼み）
ev(ago(4), by("c2"), "decision.requested", {
  decisionId: "d-open",
  nodeId: "c2",
  question: `枠が埋まったとき、どのタブを譲らせますか ${XSS}`,
  options: ["いちばん古いタブ", "裏に回ったタブ"],
});
instruct(ago(3), ago(2), "c1", by("root"), "凡例も見本にそろえる");
ev(ago(2), by("c3"), "scope.extensionRequested", {
  extensionId: "x-open",
  nodeId: "c3",
  target: { kind: "write", value: "docs/ui.md" },
  reason: `文書も直したい ${XSS}`,
});
// 頼みのあとの報告（図の上りの線は、答え待ちの頼みを優先して、柿色の頼みのまま）
report(ago(1), "c3", "progress", "頼みの答えを待つあいだ、ほかを進めています");
instruct(ago(1), undefined, "c4", HUMAN, "人からの短い指示（まだ届いていない）");

const fold = (es, base) => {
  const r = core.foldEvents(es, base);
  if (!r.ok) throw new Error(`種を畳めない: ${r.error.code} ${r.error.cause}`);
  return r.value;
};
let state = fold(events);

// --- --live: 作り物のやり取りを足し、段を進める（イベントを 1 つ足して畳み直す）---
// 作り物のやり取りは、動いている子と孫にだけ足す（答え待ち・止まっているかも・失敗の子に「いま」のやり取りを出さない）
const LIVE_TARGETS = [
  ["c1", "root"],
  ["g6", "c1"],
];
let liveStep = 0;
let pending; // { seq, nodeId, stage }
const tick = () => {
  const at = new Date().toISOString();
  const start = events.length;
  if (pending === undefined) {
    const [nodeId, parentId] = LIVE_TARGETS[liveStep++ % LIVE_TARGETS.length];
    pending = {
      seq: instruct(at, undefined, nodeId, by(parentId), "作り物の指示"),
      nodeId,
      stage: "sent",
    };
  } else if (pending.stage === "sent") {
    ev(at, SYSTEM, "node.instructionDelivered", {
      nodeId: pending.nodeId,
      instructedSeq: pending.seq,
    });
    pending = { ...pending, stage: "delivered" };
  } else {
    report(at, pending.nodeId, "progress", "作り物の報告");
    pending = undefined;
  }
  try {
    state = fold(events.slice(start), state);
  } catch (e) {
    process.stderr.write(`--live のやり取りを足せませんでした: ${e.message}\n`);
    if (timer !== undefined) clearInterval(timer);
  }
};

// --- 立てる ---
const stateDir = mkdtempSync(join(tmpdir(), "touryou-ui-preview-"));
// どの終わり方でも（例外で落ちたときも）一時の場所を消す。exit の中は同期の処理だけ
process.on("exit", () => rmSync(stateDir, { recursive: true, force: true }));
// 試験だけが、自分で決めたトークンを渡せる（入れるだけ。画面・ログ・引数には出さない）
const TOKEN_ENV = process.env.TOURYOU_PREVIEW_TOKEN;
const token =
  typeof TOKEN_ENV === "string" && /^[A-Za-z0-9_-]{32,}$/.test(TOKEN_ENV)
    ? TOKEN_ENV
    : randomBytes(32).toString("base64url");
// 画面の操作（答え・承認・却下・回収・止める など）は、どれも平易な文で断る（内部の言葉「未実装」を出さない）
const PREVIEW_ONLY = core.failure(
  "previewOnly",
  "ui-preview は見るための道具なので、操作は試せません。操作は本物の daemon で試してください。",
  "本物の daemon で状態画面を開く（/touryou:ui）",
);
const previewHandlers = Object.fromEntries(
  [...new Set(Object.values(core.ROLE_OPERATIONS).flat())].map((op) => [
    op,
    () => ({ ok: false, error: PREVIEW_ONLY }),
  ]),
);
const server = api.createApiServer({
  credentials: creds.createCredentialStore({ humanToken: token }),
  getState: () => state,
  handlers: previewHandlers,
  // 停止の代行依頼（本物の daemon は、アダプタの能力表で決める。ここでは g5 だけ親に代行してもらう）
  stopDelegated: (id) => id === "g5",
  // 左上のリポジトリの名前と、`claude attach` を打つ場所（本物の daemon は repoRoot から作る）
  repoName: "sample-repo",
  attachDir: "/path/to/sample-repo",
  // 設定の窓の「子の権限の規則」（本物の daemon は、設定ファイルの規則と、足した規則を出す。ここは見本の規則）。読み取りだけ
  policyView: () => ({
    rules: [
      { list: "allow", rule: "Bash(git status:*)", source: "config" },
      { list: "allow", rule: "Read(docs/**)", source: "runtime" },
      { list: "deny", rule: "Bash(rm -rf:*)", source: "config" },
      { list: "ask", rule: "Bash(git push:*)", source: "config" },
    ],
    mcpGate: {},
    limitRules: {},
  }),
});
let timer;
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  if (timer !== undefined) clearInterval(timer);
  try {
    await server.close();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    process.stdout.write("止めました（一時の場所を消しました）。\n");
    process.exit(0);
  }
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const { port, url } = await server.listen(0);
writeFileSync(join(stateDir, "port"), `${port}\n`, { mode: 0o600 });
if (LIVE) timer = setInterval(tick, LIVE_MS);
process.stdout.write(
  `作り物の記録で、状態画面を立てました: ${url}/ui （port ${port}）${LIVE ? "。--live: やり取りを足し続けます" : ""}\n`,
);

process.stdout.write(
  "作り物のデータです。画面の操作（答え・承認・回収など）は試せません。押すと失敗します。\n",
);
if (!OPEN) {
  process.stdout.write("--no-open のため、ブラウザは開きません。Ctrl+C で止めます。\n");
} else {
  let ticket;
  try {
    const res = await fetch(`${url}/v1/ui/ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    ticket = typeof body?.value?.ticket === "string" ? body.value.ticket : undefined;
  } catch {
    ticket = undefined;
  }
  if (ticket === undefined) {
    process.stderr.write("チケットを受け取れませんでした。\n");
    await stop();
  } else {
    execFile("/usr/bin/open", [`${url}/ui#ticket=${ticket}`], (err) => {
      if (err) {
        process.stderr.write(
          "ブラウザを開けませんでした（Mac で実行してください）。Ctrl+C で止めます。\n",
        );
      } else {
        process.stdout.write(
          "既定のブラウザで開きました（60 秒のうちに開かないと使えなくなります。そのときは起動し直してください）。Ctrl+C で止めます。\n",
        );
      }
    });
  }
}
