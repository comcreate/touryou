/**
 * git の作業ツリーの口（`WorktreePorts` の実装）。ノードごとの作業ツリーとブランチを、ノード ID から決定的に導く
 * （エージェントに決めさせない。DC_003）。状態は持たず、git の登録（`git worktree list`）を正とする。
 *
 * - 名前: ブランチ `touryou/<名前>`、作業ツリー `<worktreeRoot>/<名前>`。`<名前>` は、ノード ID の安全な部分（最大 32 文字）と
 *   ノード ID のハッシュ（12 桁）から導く（ノード ID の `:` などは git のブランチ名に使えないため）。
 * - 作成: 親のブランチ（根の子は、根の作業ツリーで今チェックアウト中のブランチ。detached HEAD は失敗）から、
 *   `git worktree add --track -b`。上流を親のブランチにするので、統合済みかの判定とブランチの削除（`-d`）が、親のブランチを基準にできる。
 *   同じノード ID の再要求は、同じ結果を返す（冪等）。登録されていない同名のディレクトリがあれば、上書きせずに失敗する。
 * - 削除: **`--force` を使わない**（`git worktree remove`）。ブランチは `git branch -d`（統合済みだけ。**`-D` は、強制の回収〔破棄の判断を経たノード〕のときだけ**。
 *   強制のときは、消す前に、先端を `refs/touryou/discarded/<名前>` に付け替えて保管する。`docs/discarded-work.md`）。
 *   未保存の変更・未追跡のファイルがあれば作業ツリーを消さずに失敗し、未統合のコミットがあればブランチを残して失敗する
 *   （失うものがある場合は拒否する。NFR_006）。`expectedPath`（判定に使った実パス）が、そのノードの作業ツリーと違えば、何もしない。
 * - 事実: きれいか（`git status --porcelain --untracked-files=all` が空）、統合済みか（上流に含まれる）。調べられなければ、
 *   安全側（きれいでない・統合済みでない）にする。
 * - `repoRoot`・`worktreeRoot` は、実パス（リンクを含まない）であること。git の操作は直列に行う。
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type Failure,
  failure,
  isCommitSha,
  isPathUnder,
  LIMITS,
  type Result,
} from "@touryou/core";
import { collisionKey, ownedBy } from "./discarded-keys.js";
import { copySeed, planSeed, readSeedList } from "./worktree-seed.js";

/**
 * 子の作業ツリーの印のファイル名。作業ツリーの git のディレクトリに置く。中身はノードの ID だけ（秘密は入れない）。
 * `packages/mcp/src/child-marker.ts` の `CHILD_WORKTREE_MARKER` と同じ値にする。
 */
export const CHILD_WORKTREE_MARKER = "touryou-child";

/** 作業ツリーを作るときに写したパスの記録（JSON の配列）。印と同じ場所（作業ツリーの git のディレクトリ）に置く。 */
export const SEEDED_RECORD_FILE = "touryou-seeded";

export interface GitResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
export type GitRunner = (
  args: readonly string[],
  opts: { readonly cwd: string },
) => Promise<GitResult>;

/**
 * git に渡す環境変数: `GIT_` で始まるものをすべて外し（`GIT_DIR`・`GIT_WORK_TREE`・`GIT_CONFIG_*` などで、別のリポジトリ・設定を
 * 指されないように）、システムの設定を読まず、対話を求めず、出力の言語を固定する。
 */
export function gitEnv(parent: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent)) if (!k.startsWith("GIT_")) env[k] = v;
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
}

/** git（Xcode の Command Line Tools）がないときに、git の出力の先頭に付ける説明。 */
export const GIT_MISSING_MESSAGE =
  "git（Xcode Command Line Tools）が使えません。Terminal で xcode-select --install を実行して（Xcode だけを入れているときは、ライセンスに同意して）、終わってから、daemon を起動し直してください";

/**
 * git が使えない（起動できない〔ENOENT〕・macOS の仮の git〔Command Line Tools がない〕・Xcode のライセンスに未同意）ことを示す出力か。
 * - ENOENT は、cwd がないときも出る（Node の execFile）。**cwd があるときだけ**、git がないとみなす（`cwdExists`）。
 * - 文言は、仮の git・xcrun に特有のものに絞る（`xcrun: error` だけでは、フックなどの出力でも当たりうるので、使わない）。
 *   文言は推測で、まだ確かめていない。
 */
export function isGitMissing(spawnCode: unknown, stderr: string, cwdExists = true): boolean {
  if (spawnCode === "ENOENT") return cwdExists;
  return /invalid active developer path|no developer tools were found|requires the command line developer tools|agree(?:d|ing)? to the Xcode (?:and Apple SDKs )?license/i.test(
    stderr,
  );
}

/**
 * `git` の実行。例外を出さず、結果（終了コード・出力）を返す。起動できない・時間切れは `code: null`。
 * git がない（`isGitMissing`）ときは、終了コードはそのままに、stderr の先頭に `GIT_MISSING_MESSAGE` を付ける
 * （呼ぶ側は stderr の先頭を切り詰めて表示するため、説明を先に置く）。`bin` は試験で差し替える。
 */
export const makeNodeGit =
  (bin = "git"): GitRunner =>
  (args, { cwd }) =>
    new Promise((resolve) => {
      execFile(
        bin,
        [...args],
        {
          cwd,
          timeout: 60_000,
          maxBuffer: 16 * 1024 * 1024,
          encoding: "utf8",
          env: gitEnv(process.env),
        },
        (err, stdout, stderr) => {
          if (err === null) return resolve({ code: 0, stdout, stderr });
          const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
          const raw = typeof stderr === "string" && stderr !== "" ? stderr : String(err.message);
          resolve({
            code: typeof code === "number" ? code : null,
            stdout: typeof stdout === "string" ? stdout : "",
            stderr: isGitMissing(code, raw, existsSync(cwd))
              ? `${GIT_MISSING_MESSAGE}（${raw.trim()}）`
              : raw,
          });
        },
      );
    });

export const nodeGit: GitRunner = makeNodeGit();

export interface GitPortsOptions {
  readonly repoRoot: string;
  readonly worktreeRoot: string;
  readonly rootCwd: string;
  readonly rootNodeId: string;
  /**
   * 再生成できるので、残っていても未保存の変更とみなさない、gitignore の対象（パスの先頭のディレクトリ名）。
   * これ以外の gitignore の対象（`.env` など）が作業ツリーにあれば、きれいでない（回収は拒否される）。既定は
   * `node_modules`・`dist`・`.turbo`。
   */
  readonly regenerableIgnored?: readonly string[];
  /**
   * 採用したノード（`node.adopted`。#163）の作業ツリーとブランチ。あれば、ノード ID から導く値の代わりに使い、
   * 回収でも作業ツリーとブランチは消さない（採用は、既存の作業ツリーを預かるだけ）。daemon の記録（状態）から引く。
   */
  readonly adoptedOf?: (
    nodeId: string,
  ) => { readonly worktree: string; readonly branch: string } | undefined;
  /** 保管する、破棄した成果（`refs/touryou/discarded/*`）の数の上限。上限に達したら、強制の回収は失敗する。省略すると 200。 */
  readonly discardedRefsMax?: number;
  /** 作業ツリーに設定ファイルを写した結果の通知（`worktree-seed.ts`）。省略すると、標準エラーに 1 行（JSON）出す。 */
  readonly onSeed?: (e: {
    nodeId: string;
    copied: readonly string[];
    skipped: readonly string[];
    missing: readonly string[];
  }) => void;
}

export const DEFAULT_DISCARDED_REFS_MAX = 200;
export const DISCARDED_REF_PREFIX = "refs/touryou/discarded/";

/** 保管している、破棄した成果（1 件）。`subject` は、コミットメッセージ由来の信頼できない入力（呼び出し側が整える）。 */
export interface DiscardedItem {
  /** `refs/touryou/discarded/` の後ろ。 */
  readonly key: string;
  readonly tip: string;
  readonly committedAt?: string;
  readonly subject?: string;
}

/** 統合の結果。`target` は親のブランチの名前、`tip` は統合した子の先端。 */
export interface IntegrateValue {
  readonly alreadyIntegrated: boolean;
  readonly target: string;
  readonly tip: string;
}

export const DEFAULT_REGENERABLE_IGNORED: readonly string[] = ["node_modules", "dist", ".turbo"];

/** 強制の回収で失われるもの（生の事実。件名は信頼できない入力で、呼び出し側が整える）。 */
export interface LossFacts {
  /** 上流に統合されていないコミットの数。上流が分からなければ省略。 */
  aheadCommits?: number;
  /** 統合されていないコミットの件名（新しい順。最大 `LIMITS.lossSubjects` 件）。 */
  subjects: string[];
  uncommitted: boolean;
  untracked: number;
  /** `git status` が失敗して、`uncommitted`・`untracked` が分からない。 */
  workingTreeUnknown?: true;
}

export interface GitPorts {
  /** 強制の回収で失われるもの。作業ツリーが登録されていなければ（調べられなければ）`undefined`。 */
  lossFor(nodeId: string): Promise<LossFacts | undefined>;
  /** `opts.mergeEvidenceTip`: 統合済みの証拠の先端。ブランチの先端と一致すれば、祖先判定が偽でも `merged`（`mergedBy: "evidence"`）。 */
  factsFor(
    nodeId: string,
    opts?: { mergeEvidenceTip?: string },
  ): Promise<
    | {
        merged: boolean;
        /** `merged` の根拠。祖先判定か、統合済みの証拠か。 */
        mergedBy?: "ancestor" | "evidence";
        /** 子のブランチ名。 */
        branch?: string;
        /** 親のブランチ（上流）の名前。分からなければ省略。 */
        base?: string;
        clean: boolean;
        worktreePath: string;
        headCommit?: string;
        headUnknown?: true;
        /** 作業ツリーもブランチも、もうない（消すものがない。Issue #137）。 */
        gone?: true;
      }
    | undefined
  >;
  removeWorktree(
    nodeId: string,
    opts: {
      expectedPath: string;
      force?: boolean;
      onTip?: (tip: string, ref?: string) => void;
      /** 統合済みの証拠の先端（`force` とは別の経路）。先端が一致するときだけ、保管してから `-D` で消す。 */
      mergeEvidenceTip?: string;
    },
  ): Promise<Result<undefined, Failure>>;
  /**
   * 子のブランチを、上流（親のブランチ）へ fast-forward だけで統合する（Issue #4）。すでに統合済みなら何もしない。
   * 親のブランチがどこかの作業ツリーでチェックアウトされていれば、その作業ツリーで `git merge --ff-only`（未保存の変更があれば拒む）。
   * されていなければ `git update-ref`（古い値の検査つき）。fast-forward できなければ何も変えずに `notFastForward`。
   */
  integrate(nodeId: string): Promise<Result<IntegrateValue, Failure>>;
  /** 保管している、破棄した成果の一覧（上限まで）と、保管の数の上限。 */
  discardedList(): Promise<Result<{ items: readonly DiscardedItem[]; max: number }, Failure>>;
  /** ノード ID から導く、保管の鍵（`<名前>`）。 */
  discardedKeyOf(nodeId: string): string;
  /** 保管している先端から、新しいブランチを作る（作成だけ。既存のブランチは上書きしない）。保管は残る。 */
  discardedRestore(req: {
    key: string;
    branch?: string;
  }): Promise<Result<{ branch: string; tip: string }, Failure>>;
  /** 保管を 1 件消す（取り消せない）。`expectTip`（一覧で表示した先端）と、今の先端が一致したときだけ消す。 */
  discardedDrop(
    key: string,
    expectTip: string,
  ): Promise<Result<{ key: string; tip: string }, Failure>>;
  /** 最終削除された木のノードの保管を消す（失敗は、消せたものと残ったものを返す）。 */
  discardedDeleteFor(nodeIds: readonly string[]): Promise<{
    deleted: readonly { key: string; tip: string }[];
    failed: readonly { key: string; cause: string }[];
  }>;
  provisionWorktree(req: {
    parentId: string;
    nodeId: string;
  }): Promise<Result<{ worktreePath: string }, Failure>>;
  /**
   * 既存の作業ツリーを、子として採用できるか検査する（#163。何も変えない）。`repoRoot` に登録されたブランチ付きの作業ツリーで、
   * 主の作業ツリー・根・親の作業ツリーでなく、ブランチが指定と同じで親のブランチと別、上流が親のブランチ、子の印がまだない、を確かめる。
   * 成功すると、実パスと、未コミットの変更があるか（`dirty`）を返す。
   */
  inspectAdoption(req: {
    parentId: string;
    worktree: string;
    branch: string;
  }): Promise<Result<{ worktreePath: string; branch: string; dirty: boolean }, Failure>>;
  /** 採用する作業ツリーの git のディレクトリに、子の印（ノードの ID）を書く。すでに印があれば失敗する。 */
  markAdopted(nodeId: string, worktreePath: string): Promise<Result<undefined, Failure>>;
  /** 採用の途中の失敗で、書いた印を片付ける（作業ツリーとブランチは消さない）。印がなくても成功する。 */
  unmarkAdopted(worktreePath: string): Promise<void>;
  /** 採用したノードの作業ツリーとブランチを引く関数を差し込む（記録は、口より後に作られるため）。 */
  useAdopted(resolve: (nodeId: string) => { worktree: string; branch: string } | undefined): void;
  cwdOf(nodeId: string): Promise<string | undefined>;
}

const fail = (code: string, cause: string, ...next: [string, ...string[]]) => ({
  ok: false as const,
  error: failure(code, cause, ...next),
});

const nameOf = (nodeId: string): string => {
  const slug = nodeId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
  const h = createHash("sha256").update(nodeId, "utf8").digest("hex").slice(0, 12);
  return `${slug}-${h}`;
};

const realOrUndefined = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

/**
 * `repoRoot` が git のリポジトリか（`git rev-parse --git-dir` が通るか）。`touryou-daemon --check-config` で使う
 * （常駐にする前に、消したフォルダ・git でないフォルダを指した設定を止める。Issue の背景は docs/launchd.md）。
 */
export async function checkGitRepo(
  repoRoot: string,
  run: GitRunner = nodeGit,
): Promise<Result<undefined, Failure>> {
  const r = await run(["rev-parse", "--git-dir"], { cwd: repoRoot });
  if (r.code === 0) return { ok: true, value: undefined };
  return r.stderr.startsWith(GIT_MISSING_MESSAGE)
    ? fail(
        "invalidConfig",
        GIT_MISSING_MESSAGE,
        "git を入れ、plist の PATH（--path-prefix）に git の場所を足す",
      )
    : fail(
        "invalidConfig",
        `repoRoot ${repoRoot} が、git のリポジトリでない`,
        "repoRoot を、git のリポジトリの実パスにする",
      );
}

export function createGitPorts(
  options: GitPortsOptions,
  run: GitRunner = nodeGit,
): Result<GitPorts, Failure> {
  for (const [k, v] of Object.entries({
    repoRoot: options.repoRoot,
    worktreeRoot: options.worktreeRoot,
  })) {
    if (realOrUndefined(v) !== v) {
      return fail(
        "invalidConfig",
        `${k} ${v} が、実パスでない（存在しない、またはリンクを含む）`,
        `${k} を、リンクを解決した実パスで指定する`,
      );
    }
  }
  const { repoRoot, worktreeRoot, rootCwd, rootNodeId } = options;
  const realRootCwd = realOrUndefined(rootCwd);
  if (realRootCwd === undefined || !isPathUnder(realRootCwd, repoRoot)) {
    return fail(
      "invalidConfig",
      `rootCwd ${rootCwd} が、repoRoot の配下の実在するパスでない`,
      "rootCwd を、repoRoot 自身かその配下にする",
    );
  }
  const regenerable = new Set(options.regenerableIgnored ?? DEFAULT_REGENERABLE_IGNORED);
  const onSeed =
    options.onSeed ??
    ((e) =>
      process.stderr.write(
        `${JSON.stringify({ at: new Date().toISOString(), event: "worktreeSeeded", ...e })}\n`,
      ));
  /**
   * 作業ツリーを作るときに写したファイルの記録（`<gitDir>/touryou-seeded`）。回収の判定で、失われるものに数えない。
   * 一覧（JSON）は読み直さない（後から変わっても判定がずれない）。記録がない（古い作業ツリー）・読めない・形が違うなら空（従来どおり数える）。
   */
  const seededPaths = async (path: string): Promise<ReadonlySet<string>> => {
    const gitDir = await git(["rev-parse", "--absolute-git-dir"], path);
    if (gitDir.code !== 0 || gitDir.stdout.trim() === "") return new Set();
    try {
      const raw: unknown = JSON.parse(
        readFileSync(join(gitDir.stdout.trim(), SEEDED_RECORD_FILE), "utf8"),
      );
      return new Set(
        Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string") : [],
      );
    } catch (e) {
      // 記録がない（古い作業ツリー）は、想定どおりなので残さない。壊れている・読めないときだけ残す
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        process.stderr.write(
          `${JSON.stringify({ at: new Date().toISOString(), event: "worktreeSeedRecordUnreadable", path, reason: e instanceof Error ? e.message : String(e) })}\n`,
        );
      }
      return new Set();
    }
  };

  // git の操作は直列に行う（作業ツリーの追加・削除は、リポジトリの内部で競合しうる）。
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const next = tail.then(f, f);
    tail = next.catch(() => undefined);
    return next;
  };
  const git = (args: readonly string[], cwd = repoRoot): Promise<GitResult> => run(args, { cwd });
  /** その結果が「git がない」（`GIT_MISSING_MESSAGE` で始まる stderr）か。結果ごとに判定する（共有の状態を持たない）。 */
  const missingIn = (r: GitResult): boolean =>
    r.code !== 0 && r.stderr.startsWith(GIT_MISSING_MESSAGE);
  /** stderr を捨てる git の失敗の原因。git がないときは、先頭に説明を付ける（終了コード・失敗の code は変えない）。 */
  const gitCause = (cause: string, missing: boolean): string =>
    missing ? `${GIT_MISSING_MESSAGE}（${cause}）` : cause;

  const discardedMax = options.discardedRefsMax ?? DEFAULT_DISCARDED_REFS_MAX;
  const NEXT_STORE = [
    "touryou discarded list で、保管している成果を確かめる",
    "不要なものは touryou discarded drop <nodeId> --yes で消す",
    "必要なものは touryou discarded restore <nodeId> でブランチに取り出してから消す",
  ] as [string, ...string[]];
  /** `refs/touryou/discarded/<key>` の形（git の ref 名として正しいか）を、git で確かめる。 */
  const validRef = async (ref: string): Promise<boolean> =>
    (await git(["check-ref-format", ref])).code === 0;
  const validBranch = async (name: string): Promise<boolean> =>
    // `refs/` で始まる名前（`refs/heads/refs/...` になる）と、`@` だけの名前は、拒否する。
    !name.startsWith("refs/") &&
    name !== "@" &&
    (await git(["check-ref-format", "--branch", name])).code === 0;
  const zeros = (sha: string): string => "0".repeat(sha.length);

  // 採用したノード（#163）は、記録した作業ツリーとブランチを使う。ほかは、ノード ID から導く。
  // 記録（イベントログ）は、口を作った後に作られるので、解決する関数は後から差し込める（`useAdopted`）。
  let adoptedOf = options.adoptedOf;
  const branchOf = (nodeId: string): string =>
    adoptedOf?.(nodeId)?.branch ?? `touryou/${nameOf(nodeId)}`;
  const pathOf = (nodeId: string): string =>
    adoptedOf?.(nodeId)?.worktree ?? join(worktreeRoot, nameOf(nodeId));

  /** 登録されている作業ツリーのパスとブランチ（`git worktree list --porcelain`）。調べられなければ `{ missing }`（git がないか）。 */
  const registeredWorktrees = async (): Promise<Map<string, string> | { missing: boolean }> => {
    const r = await git(["worktree", "list", "--porcelain"]);
    if (r.code !== 0) return { missing: missingIn(r) };
    const out = new Map<string, string>();
    let cur: string | undefined;
    for (const line of r.stdout.split("\n")) {
      if (line.startsWith("worktree ")) cur = line.slice("worktree ".length);
      else if (line.startsWith("branch refs/heads/") && cur !== undefined) {
        out.set(cur, line.slice("branch refs/heads/".length));
      }
    }
    return out;
  };

  /** 登録されているか。調べられなければ `{ missing }`（git がないか）。 */
  const isRegistered = async (nodeId: string): Promise<boolean | { missing: boolean }> => {
    const list = await registeredWorktrees();
    if (!(list instanceof Map)) return list;
    return list.get(pathOf(nodeId)) === branchOf(nodeId);
  };

  const branchExists = async (branch: string): Promise<boolean> =>
    (await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;

  /** ブランチの先端（コミット SHA）。取得できなければ `undefined`。 */
  const tipOfBranch = async (branch: string): Promise<string | undefined> => {
    const r = await git(["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
    const sha = r.stdout.trim();
    return r.code === 0 && isCommitSha(sha) ? sha : undefined;
  };

  /** 上流の完全な ref 名（`refs/heads/x`・`refs/remotes/<remote>/x`）から、ブランチ名（`x`）を取り出す。分からなければ `undefined`。 */
  const baseBranchOf = (full: string): string | undefined => {
    const local = /^refs\/heads\/(.+)$/.exec(full);
    if (local?.[1] !== undefined) return local[1];
    const remote = /^refs\/remotes\/[^/]+\/(.+)$/.exec(full);
    return remote?.[1];
  };

  const dirExists = (p: string): boolean => {
    try {
      lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * `git status --ignored` の `!! <パス>` の行が、シンボリックリンクそのものか。リンクは、消してもリンク先を失わないので、
   * 失われるものに数えない（作業ツリーの作成時にできる `.envrc` のリンクなど。Issue #160）。調べられなければ false（安全側）。
   */
  const isIgnoredLink = (worktreePath: string, line: string): boolean => {
    if (!line.startsWith("!! ")) return false;
    try {
      return lstatSync(join(worktreePath, line.slice(3).replace(/\/$/, ""))).isSymbolicLink();
    } catch {
      return false;
    }
  };

  /**
   * 作業ツリーの `git status --porcelain` の行（空行を除く）。調べられなければ `undefined`。
   * `--ignored=matching` は、丸ごと gitignore のディレクトリを `!! dir/` の 1 行にまとめる。一覧（`seeded`）のファイルがその中にあるときは、
   * 中身が一覧のファイルだけかを確かめられないので、そのディレクトリだけ、ファイルごとの行に開く（`--ignored=traditional`）。
   * 一覧のファイルを含まないディレクトリ（`node_modules/` など）は、開かない（行が膨らむため）。
   * fsmonitor・フックは使わない（作業ツリーの設定に、コマンドを走らせない）。
   */
  const statusLines = async (
    path: string,
    seeded: ReadonlySet<string>,
  ): Promise<string[] | undefined> => {
    const base = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "status"];
    const status = await git(
      [...base, "--porcelain", "--untracked-files=all", "--ignored=matching"],
      path,
    );
    if (status.code !== 0) return undefined;
    const lines: string[] = [];
    for (const l of status.stdout.split("\n")) {
      if (l === "") continue;
      const dir = l.startsWith("!! ") && l.endsWith("/") ? l.slice(3) : undefined;
      if (dir === undefined || ![...seeded].some((s) => s.startsWith(dir))) {
        lines.push(l);
        continue;
      }
      const inner = await git(
        [...base, "--porcelain", "--untracked-files=all", "--ignored=traditional", "--", dir],
        path,
      );
      if (inner.code !== 0) return undefined;
      lines.push(...inner.stdout.split("\n").filter((x) => x !== ""));
    }
    return lines;
  };

  /** きれいか: 未保存の変更・未追跡のファイルがなく、gitignore の対象は、再生成できるもの（許可リスト）かリンクだけ。調べられなければ false。 */
  const isClean = async (path: string): Promise<boolean> => {
    const seeded = await seededPaths(path);
    const lines = await statusLines(path, seeded);
    return (
      lines !== undefined &&
      lines.every(
        (l) =>
          ((l.startsWith("!! ") || l.startsWith("?? ")) && seeded.has(l.slice(3))) ||
          (l.startsWith("!! ") && regenerable.has(l.slice(3).split("/")[0] ?? "")) ||
          isIgnoredLink(path, l),
      )
    );
  };

  /**
   * ブランチの先端（最終コミット）。取れて SHA の形なら `headCommit`。ブランチがない（`rev-parse --verify -q` が code 1）なら、何も載せない。
   * それ以外（git を起動できない・時間切れ・予期しない終了コード・SHA の形でない出力）は、取得の失敗として `headUnknown: true`
   * （「先端がない」と取り違えない）。
   */
  const headFields = async (
    nodeId: string,
  ): Promise<{ headCommit?: string; headUnknown?: true }> => {
    const r = await git(["rev-parse", "--verify", "-q", `${branchOf(nodeId)}^{commit}`]);
    const sha = r.stdout.trim();
    if (r.code === 0) return isCommitSha(sha) ? { headCommit: sha } : { headUnknown: true };
    return r.code === 1 ? {} : { headUnknown: true };
  };

  /** 失われるもの: 統合されていないコミット（数と件名）、追跡中の変更、未追跡のファイルの数。 */
  const lossOf = async (nodeId: string): Promise<LossFacts | undefined> => {
    const registered = await isRegistered(nodeId);
    // 作業ツリーの一覧を取れなければ、調べられなかった（呼び出し側が「不明」として扱う）。
    if (typeof registered !== "boolean")
      throw new Error(gitCause("作業ツリーの一覧を取得できなかった", registered.missing));
    const path = pathOf(nodeId);
    const branch = branchOf(nodeId);
    // 作業ツリーは消えたがブランチだけ残った（途中の失敗）ノード: ブランチ側の情報を返す（`factsFor` と同じ状態の扱い）。
    const branchOnly = registered !== true && !dirExists(path) && (await branchExists(branch));
    if (registered !== true && !branchOnly) return undefined;
    const out: LossFacts = { subjects: [], uncommitted: false, untracked: 0 };
    const up = await git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
    const upstream = up.code === 0 ? up.stdout.trim() : "";
    if (upstream !== "") {
      const count = await git(["rev-list", "--count", `${upstream}..${branch}`]);
      const n = Number(count.stdout.trim());
      if (count.code === 0 && Number.isInteger(n) && n >= 0) out.aheadCommits = n;
      if (out.aheadCommits !== undefined && out.aheadCommits > 0) {
        const log = await git([
          "log",
          "-n",
          String(LIMITS.lossSubjects),
          "--format=%s",
          `${upstream}..${branch}`,
        ]);
        if (log.code === 0) out.subjects = log.stdout.split("\n").filter((l) => l !== "");
      }
    }
    if (branchOnly) return out; // 作業ツリーがないので、未保存の変更・未追跡のファイルは、ない
    const seeded = await seededPaths(path);
    const lines = await statusLines(path, seeded);
    if (lines === undefined) out.workingTreeUnknown = true;
    else {
      for (const line of lines) {
        if ((line.startsWith("!! ") || line.startsWith("?? ")) && seeded.has(line.slice(3)))
          continue;
        if (line.startsWith("?? ")) out.untracked += 1;
        else if (line.startsWith("!! ")) {
          // 再生成できる gitignore の対象（許可リスト）は、失われるものに数えない。
          if (!regenerable.has(line.slice(3).split("/")[0] ?? "") && !isIgnoredLink(path, line))
            out.untracked += 1;
        } else out.uncommitted = true;
      }
    }
    return out;
  };

  /** 保管の一覧（`refs/touryou/discarded/*`）。 */
  const listDiscarded = async (): Promise<Result<DiscardedItem[], Failure>> => {
    const r = await git([
      "for-each-ref",
      "--format=%(refname)%09%(objectname)%09%(committerdate:iso-strict)%09%(contents:subject)",
      DISCARDED_REF_PREFIX,
    ]);
    if (r.code !== 0) {
      return fail(
        "gitFailed",
        gitCause("保管の一覧を取得できなかった", missingIn(r)),
        "git の状態を確認する",
      );
    }
    const items: DiscardedItem[] = [];
    for (const line of r.stdout.split("\n")) {
      if (line === "") continue;
      const [ref, tip, at, ...subject] = line.split("\t");
      if (ref === undefined || tip === undefined || !ref.startsWith(DISCARDED_REF_PREFIX)) continue;
      items.push({
        key: ref.slice(DISCARDED_REF_PREFIX.length),
        tip,
        ...(at === undefined || at === "" ? {} : { committedAt: at }),
        ...(subject.length === 0 ? {} : { subject: subject.join("\t") }),
      });
    }
    return { ok: true, value: items };
  };

  /**
   * 強制の回収で消すブランチの先端を、`refs/touryou/discarded/<名前>` に付け替えて保管する（`update-ref` の古い値の検査で、作成だけ。
   * 原子的）。同じ名前があり、同じ先端なら成功（冪等）。違う先端なら、上書きせず、`<名前>-<先端の先頭 12 桁>` に置く。
   * 上限に達していたら、失敗する（成果を黙って捨てない）。作れなければ失敗する（呼び出し側は、何も消さない）。
   */
  const keepDiscarded = async (
    nodeId: string,
    tip: string,
  ): Promise<Result<{ ref: string }, Failure>> => {
    const listed = await listDiscarded();
    if (!listed.ok) return listed;
    const base = nameOf(nodeId);
    const mine = new Set([base]);
    const owned = listed.value.filter((i) => ownedBy(i.key, mine));
    const alreadyKept = owned.find((i) => i.tip === tip);
    if (alreadyKept !== undefined) {
      return { ok: true, value: { ref: `${DISCARDED_REF_PREFIX}${alreadyKept.key}` } };
    }
    if (listed.value.length >= discardedMax) {
      return fail(
        "discardedStoreFull",
        `保管している破棄した成果が上限（${discardedMax} 件）に達している（何も消さなかった）`,
        ...NEXT_STORE,
      );
    }
    // 同じ名前の保管がすでにあれば（違う先端）、上書きせず、`<名前>.<先端の先頭 12 桁>` に置く（ほかのノードの名前と取り違えない形）。
    const key = owned.some((i) => i.key === base) ? collisionKey(base, tip) : base;
    const ref = `${DISCARDED_REF_PREFIX}${key}`;
    if (!(await validRef(ref))) {
      return fail(
        "keepFailed",
        "保管の ref の名前が、git の規則に合わない（何も消さなかった）",
        "ノード ID を確認する",
      );
    }
    const r = await git(["update-ref", ref, tip, zeros(tip)]);
    if (r.code !== 0) {
      return fail(
        "keepFailed",
        `破棄する成果を保管できなかった（何も消さなかった）: ${r.stderr.trim().slice(0, 200)}`,
        "もう一度回収する",
      );
    }
    return { ok: true, value: { ref } };
  };

  const ports: GitPorts = {
    discardedKeyOf: nameOf,
    discardedList: () =>
      serial(async () => {
        const listed = await listDiscarded();
        if (!listed.ok) return listed;
        const items = listed.value.slice(0, discardedMax);
        return { ok: true as const, value: { items, max: discardedMax } };
      }),
    discardedRestore: ({ key, branch }) =>
      serial(async () => {
        const ref = `${DISCARDED_REF_PREFIX}${key}`;
        if (!(await validRef(ref))) {
          return fail("invalidName", "保管の名前が不正", "touryou discarded list で名前を確かめる");
        }
        const tipR = await git(["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
        const tip = tipR.stdout.trim();
        if (tipR.code !== 0 || !isCommitSha(tip)) {
          return fail("notFound", "その保管はない", "touryou discarded list で名前を確かめる");
        }
        const name = branch ?? `touryou/restored/${key}`;
        if (name.startsWith("-") || !(await validBranch(name))) {
          return fail(
            "invalidName",
            "ブランチの名前が、git の規則に合わない",
            "--branch で、別の名前を指定する",
          );
        }
        // 作成だけ（古い値が 0 の検査で、既存のブランチを上書きしない。原子的）。
        const r = await git(["update-ref", `refs/heads/${name}`, tip, zeros(tip)]);
        if (r.code !== 0) {
          return fail(
            "branchExists",
            `ブランチ ${name} を作れなかった（既にある、または作れない）。上書きはしない`,
            "--branch で、別の名前を指定する",
          );
        }
        return { ok: true as const, value: { branch: name, tip } };
      }),
    discardedDrop: (key, expectTip) =>
      serial(async () => {
        const ref = `${DISCARDED_REF_PREFIX}${key}`;
        if (!(await validRef(ref))) {
          return fail("invalidName", "保管の名前が不正", "touryou discarded list で名前を確かめる");
        }
        const tipR = await git(["rev-parse", "--verify", "-q", ref]);
        const tip = tipR.stdout.trim();
        if (tipR.code !== 0 || tip === "") {
          return fail("notFound", "その保管はない", "touryou discarded list で名前を確かめる");
        }
        if (tip !== expectTip) {
          return fail(
            "tipMismatch",
            "表示した先端と、今の保管の先端が違う（消さなかった）",
            "touryou discarded list で、今の保管を確かめてから、もう一度消す",
          );
        }
        const r = await git(["update-ref", "-d", ref, tip]); // 古い値の検査つき（途中で変わっていたら消さない）
        if (r.code !== 0) {
          return fail(
            "dropFailed",
            `保管を消せなかった: ${r.stderr.trim().slice(0, 200)}`,
            "もう一度試す",
          );
        }
        return { ok: true as const, value: { key, tip } };
      }),
    discardedDeleteFor: (nodeIds) =>
      serial(async () => {
        const deleted: { key: string; tip: string }[] = [];
        const failed: { key: string; cause: string }[] = [];
        const listed = await listDiscarded();
        if (!listed.ok) return { deleted, failed: [{ key: "*", cause: listed.error.cause }] };
        const bases = new Set(nodeIds.map(nameOf));
        for (const item of listed.value) {
          if (!ownedBy(item.key, bases)) continue;
          const r = await git(["update-ref", "-d", `${DISCARDED_REF_PREFIX}${item.key}`, item.tip]);
          if (r.code === 0) deleted.push({ key: item.key, tip: item.tip });
          else failed.push({ key: item.key, cause: r.stderr.trim().slice(0, 200) });
        }
        return { deleted, failed };
      }),
    lossFor: (nodeId) => serial(() => lossOf(nodeId)),
    integrate: (nodeId) =>
      serial(async (): Promise<Result<IntegrateValue, Failure>> => {
        const branch = branchOf(nodeId);
        if (!(await branchExists(branch))) {
          return fail(
            "branchMissing",
            `子のブランチ ${branch} がない`,
            "ノードの作業ツリーの状態を確認する",
          );
        }
        const up = await git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
        const target = up.stdout.trim();
        if (up.code !== 0 || target === "" || !(await branchExists(target))) {
          return fail(
            "upstreamMissing",
            `子のブランチ ${branch} の上流（親のブランチ）が分からない`,
            "人間が、統合先を確かめて手で統合する",
          );
        }
        const tipR = await git(["rev-parse", "--verify", "-q", `${branch}^{commit}`]);
        const oldR = await git(["rev-parse", "--verify", "-q", `refs/heads/${target}^{commit}`]);
        const tip = tipR.stdout.trim();
        const old = oldR.stdout.trim();
        if (tipR.code !== 0 || oldR.code !== 0 || tip === "" || old === "") {
          return fail("gitFailed", "ブランチの先端を読めなかった", "git の状態を確認する");
        }
        if ((await git(["merge-base", "--is-ancestor", tip, old])).code === 0) {
          return { ok: true, value: { alreadyIntegrated: true, target, tip } };
        }
        if ((await git(["merge-base", "--is-ancestor", old, tip])).code !== 0) {
          return fail(
            "notFastForward",
            `親のブランチ ${target} が、子のブランチ ${branch} の分かれたあとに進んでいて、fast-forward で統合できない`,
            "人間に、統合のしかた（親のブランチでの merge か、子のブランチの rebase）を判断してもらう",
          );
        }
        const list = await registeredWorktrees();
        if (!(list instanceof Map)) {
          return fail(
            "gitFailed",
            gitCause("作業ツリーの一覧を取得できなかった", list.missing),
            "git の状態を確認する",
          );
        }
        const checkedOut = [...list].find(([, b]) => b === target)?.[0];
        if (checkedOut !== undefined) {
          const st = await git(
            ["-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=no"],
            checkedOut,
          );
          if (st.code !== 0 || st.stdout.trim() !== "") {
            return fail(
              "targetDirty",
              `親のブランチ ${target} の作業ツリーに、未保存の変更がある（または調べられない）`,
              "親の作業ツリーの変更をコミットするか片付けてから、もう一度統合する",
            );
          }
          const m = await git(
            ["-c", "core.hooksPath=/dev/null", "merge", "--ff-only", "--no-edit", tip],
            checkedOut,
          );
          if (m.code !== 0) {
            // 未追跡のファイルが上書きされる、で止まったときは、親の作業ツリーの側の問題（targetDirty）
            const untracked = /untracked working tree files? would be overwritten/i.test(m.stderr);
            return fail(
              untracked ? "targetDirty" : "notFastForward",
              `親の作業ツリーで fast-forward できなかった: ${m.stderr.trim().slice(0, 200)}`,
              "人間に、統合のしかたを判断してもらう",
            );
          }
        } else {
          const u = await git(["update-ref", `refs/heads/${target}`, tip, old]);
          if (u.code !== 0) {
            return fail(
              "gitFailed",
              "親のブランチを進められなかった",
              "git の状態を確認して、やり直す",
            );
          }
        }
        return { ok: true, value: { alreadyIntegrated: false, target, tip } };
      }),
    inspectAdoption: ({ parentId, worktree, branch }) =>
      serial(async () => {
        const NEXT_ADOPT = "採用する作業ツリーとブランチを確かめて、もう一度 node_adopt を呼ぶ";
        const real = realOrUndefined(worktree);
        if (!worktree.startsWith("/") || real === undefined) {
          return fail(
            "adoptWorktreeNotFound",
            `作業ツリー ${worktree} が、実在する絶対パスでない`,
            "git worktree list で、採用する作業ツリーの実パスを確かめる",
          );
        }
        const list = await git(["worktree", "list", "--porcelain"]);
        if (list.code !== 0) {
          return fail(
            "gitFailed",
            gitCause("作業ツリーの一覧を取得できなかった", missingIn(list)),
            "git の状態を確認する",
          );
        }
        // 先頭の項目が、主の作業ツリー（repoRoot）。
        const entries: { path: string; branch: string | undefined }[] = [];
        for (const line of list.stdout.split("\n")) {
          if (line.startsWith("worktree ")) {
            entries.push({ path: line.slice("worktree ".length), branch: undefined });
          } else if (line.startsWith("branch refs/heads/") && entries.length > 0) {
            (entries[entries.length - 1] as { branch: string | undefined }).branch = line.slice(
              "branch refs/heads/".length,
            );
          }
        }
        const entry = entries.find((e) => (realOrUndefined(e.path) ?? e.path) === real);
        if (entry === undefined) {
          return fail(
            "adoptNotRegistered",
            `${real} は、このリポジトリ（${repoRoot}）に登録された作業ツリーでない`,
            "リポジトリで git worktree add してから採用する",
            "git worktree list で、登録されている作業ツリーを確かめる",
          );
        }
        const main = entries[0];
        if (
          real === repoRoot ||
          real === realRootCwd ||
          (main !== undefined && (realOrUndefined(main.path) ?? main.path) === real)
        ) {
          return fail(
            "adoptMainWorktree",
            "主の作業ツリー（根の作業ツリー）は、子として採用できない",
            "子にする作業ツリーを、git worktree add で別に作る",
          );
        }
        if (entry.branch === undefined) {
          return fail(
            "adoptDetachedHead",
            `作業ツリー ${real} は、ブランチをチェックアウトしていない（detached HEAD）`,
            `ブランチをチェックアウトする（git switch -c <ブランチ> <親のブランチ>）。${NEXT_ADOPT}`,
          );
        }
        if (entry.branch !== branch) {
          return fail(
            "adoptBranchMismatch",
            `作業ツリー ${real} のブランチは ${entry.branch} で、指定の ${branch} と違う`,
            `branch を ${entry.branch} にして、もう一度 node_adopt を呼ぶ`,
          );
        }
        let parentBranch: string;
        let parentPath: string | undefined;
        if (parentId === rootNodeId) {
          const head = await git(["symbolic-ref", "--short", "-q", "HEAD"], rootCwd);
          parentBranch = head.stdout.trim();
          parentPath = realRootCwd;
          if (head.code !== 0 || parentBranch === "") {
            return fail(
              "rootBranchUnknown",
              "根の作業ツリーが、ブランチをチェックアウトしていない（detached HEAD など）",
              "根の作業ツリーで、ブランチをチェックアウトする",
            );
          }
        } else {
          parentBranch = branchOf(parentId);
          parentPath = realOrUndefined(pathOf(parentId));
        }
        if (parentPath !== undefined && parentPath === real) {
          return fail(
            "adoptParentWorktree",
            "親の作業ツリーそのものは、子として採用できない",
            "子にする作業ツリーを、git worktree add で別に作る",
          );
        }
        if (branch === parentBranch) {
          return fail(
            "adoptSameBranch",
            `ブランチ ${branch} は、親のブランチと同じ（子の成果を、親と分けられない）`,
            `親のブランチ（${parentBranch}）から、子のブランチを切ってチェックアウトする。${NEXT_ADOPT}`,
          );
        }
        const up = await git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
        if (up.code !== 0 || up.stdout.trim() !== parentBranch) {
          return fail(
            "adoptUpstreamMismatch",
            `ブランチ ${branch} の上流が、親のブランチ（${parentBranch}）でない（統合済みの判定と統合の基準が、上流になる）`,
            `git branch --set-upstream-to=${parentBranch} ${branch} を、人が実行する（daemon は利用者の git の設定を書き換えない）`,
            NEXT_ADOPT,
          );
        }
        const gitDir = await git(["rev-parse", "--absolute-git-dir"], real);
        if (gitDir.code !== 0 || gitDir.stdout.trim() === "") {
          return fail(
            "gitFailed",
            gitCause("作業ツリーの git のディレクトリを取得できなかった", missingIn(gitDir)),
            "git の状態を確認する",
          );
        }
        if (existsSync(join(gitDir.stdout.trim(), CHILD_WORKTREE_MARKER))) {
          return fail(
            "adoptAlreadyChild",
            "この作業ツリーは、すでに touryou の子の作業ツリー（印がある）",
            "別の作業ツリーを採用する。残った印なら、人が確かめて片付ける",
          );
        }
        return {
          ok: true as const,
          value: { worktreePath: real, branch, dirty: !(await isClean(real)) },
        };
      }),

    markAdopted: (nodeId, worktreePath) =>
      serial(async () => {
        const gitDir = await git(["rev-parse", "--absolute-git-dir"], worktreePath);
        if (gitDir.code !== 0 || gitDir.stdout.trim() === "") {
          return fail(
            "childMarkerFailed",
            "採用する作業ツリーの git のディレクトリを取得できなかった",
            "git の状態を確認する",
          );
        }
        try {
          writeFileSync(join(gitDir.stdout.trim(), CHILD_WORKTREE_MARKER), `${nodeId}\n`, {
            mode: 0o644,
            flag: "wx",
          });
        } catch {
          return fail(
            "childMarkerFailed",
            "採用する作業ツリーに、印のファイルを置けなかった",
            "git のディレクトリの書き込み権限と、ディスクの空きを確認する",
          );
        }
        return { ok: true as const, value: undefined };
      }),

    useAdopted: (resolve) => {
      adoptedOf = resolve;
    },

    unmarkAdopted: (worktreePath) =>
      serial(async () => {
        const gitDir = await git(["rev-parse", "--absolute-git-dir"], worktreePath);
        if (gitDir.code === 0 && gitDir.stdout.trim() !== "") {
          try {
            unlinkSync(join(gitDir.stdout.trim(), CHILD_WORKTREE_MARKER));
          } catch {
            // 印がなければ、片付けるものはない
          }
        }
      }),

    provisionWorktree: ({ parentId, nodeId }) =>
      serial(async () => {
        const path = pathOf(nodeId);
        const adopted = options.adoptedOf?.(nodeId);
        if (adopted !== undefined) {
          // 採用した作業ツリーは、すでにある（作らない）。
          return { ok: true as const, value: { worktreePath: realOrUndefined(path) ?? path } };
        }
        const branch = branchOf(nodeId);
        const registered = await isRegistered(nodeId);
        if (typeof registered !== "boolean") {
          return fail(
            "gitFailed",
            gitCause("作業ツリーの一覧を取得できなかった", registered.missing),
            "git の状態を確認する",
          );
        }
        if (registered)
          return { ok: true as const, value: { worktreePath: realOrUndefined(path) ?? path } };
        if (dirExists(path)) {
          return fail(
            "worktreeConflict",
            `作業ツリーの場所 ${path} に、登録されていないものがある`,
            "場所の中身を確認して、人間が片付ける",
          );
        }
        let parentBranch: string;
        if (parentId === rootNodeId) {
          const head = await git(["symbolic-ref", "--short", "-q", "HEAD"], rootCwd);
          const name = head.stdout.trim();
          if (head.code !== 0 || name === "") {
            return fail(
              "rootBranchUnknown",
              "根の作業ツリーが、ブランチをチェックアウトしていない（detached HEAD など）",
              "根の作業ツリーで、ブランチをチェックアウトする",
            );
          }
          parentBranch = name;
        } else {
          parentBranch = branchOf(parentId);
          if (!(await branchExists(parentBranch))) {
            return fail(
              "parentBranchMissing",
              "親のブランチがない",
              "親の作業ツリーの状態を確認する",
            );
          }
        }
        // 写すファイルは、作業ツリーを作る前に確かめる（不正なら、何も作らずに失敗する）。
        const seedList = readSeedList(repoRoot);
        if (!seedList.ok) return seedList;
        const seedPlan = planSeed(repoRoot, seedList.value);
        if (!seedPlan.ok) return seedPlan;
        const exists = await branchExists(branch);
        if (exists) {
          // 残っていたブランチを使うときは、上流が親のブランチのままか確かめる（違えば、統合の判定が狂う）。
          const up = await git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
          if (up.code !== 0 || up.stdout.trim() !== parentBranch) {
            return fail(
              "branchConflict",
              `ブランチ ${branch} が残っていて、上流が親のブランチ（${parentBranch}）と違う`,
              "残っているブランチの中身を確認して、人間が片付ける",
            );
          }
        }
        const args = exists
          ? ["worktree", "add", path, branch]
          : ["worktree", "add", "--track", "-b", branch, path, parentBranch];
        const r = await git(args);
        if (r.code !== 0) {
          return fail(
            "gitFailed",
            `作業ツリーを作れなかった: ${r.stderr.trim()}`,
            "git の状態を確認する",
          );
        }
        // 子の作業ツリーの印。作業ツリーの git のディレクトリ（追跡されない所）に、ノードの ID だけを書く。
        // mcp は、これがあれば根のトークンを読まずに「紐付け待ち」で開く。置けなければ、根で開いてしまうので、作業ツリーを消して失敗にする。
        const gitDir = await git(["rev-parse", "--absolute-git-dir"], path);
        let marked = false;
        if (gitDir.code === 0 && gitDir.stdout.trim() !== "") {
          try {
            writeFileSync(join(gitDir.stdout.trim(), CHILD_WORKTREE_MARKER), `${nodeId}\n`, {
              mode: 0o644,
            });
            marked = true;
          } catch {
            marked = false;
          }
        }
        if (!marked) {
          await git(["worktree", "remove", "--force", path]);
          return fail(
            "childMarkerFailed",
            "子の作業ツリーに、印のファイルを置けなかった（作業ツリーは消した）",
            "git の状態と、ディスクの空きを確認する",
          );
        }
        if (seedPlan.value.copy.length > 0 || seedPlan.value.missing.length > 0) {
          const { copied, skipped } = copySeed(repoRoot, path, seedPlan.value);
          // 写したパスの記録。回収の判定は、一覧でなくこれを読む。書けなければ記録なし（従来どおり数える＝安全側）。
          try {
            writeFileSync(join(gitDir.stdout.trim(), SEEDED_RECORD_FILE), JSON.stringify(copied), {
              mode: 0o644,
            });
          } catch (e) {
            // 記録の失敗は、処理を止めない。ただし、写したファイルが回収の判定で未追跡に数えられる原因になるので、残す
            process.stderr.write(
              `${JSON.stringify({ at: new Date().toISOString(), event: "worktreeSeedRecordFailed", nodeId, reason: e instanceof Error ? e.message : String(e) })}\n`,
            );
          }
          try {
            onSeed({ nodeId, copied, skipped, missing: seedPlan.value.missing });
          } catch {
            // 通知の失敗は、処理を止めない
          }
        }
        return { ok: true as const, value: { worktreePath: realOrUndefined(path) ?? path } };
      }),

    cwdOf: (nodeId) =>
      serial(async () =>
        (await isRegistered(nodeId)) === true ? realOrUndefined(pathOf(nodeId)) : undefined,
      ),

    factsFor: (nodeId, opts) =>
      serial(async () => {
        const path = pathOf(nodeId);
        const registered = await isRegistered(nodeId);
        if (registered !== true) {
          // 強制の回収で、作業ツリーは消えたがブランチだけ残った（途中の失敗）ノード: 消すべきものが残っていない作業ツリーとして
          // 事実を返し、判定を通して、ブランチの削除をやり直せるようにする（破棄の判断は、ハンドラが記録で確かめる）。
          if (!dirExists(path) && (await branchExists(branchOf(nodeId)))) {
            return {
              worktreePath: path,
              merged: false,
              clean: true,
              ...(await headFields(nodeId)),
            };
          }
          // 作業ツリーもブランチも、もうない（Issue #137）: 作業ツリーの一覧を取れて、登録がなく、場所もないときだけ、
          // 消すものがないことを `gone` で返す。使ってよいのは、人が破棄を決めた停止ノードだけ（ハンドラが確かめる）。
          if (registered === false && !dirExists(path)) {
            // `branchExists` は git の失敗も「ない」にするので、ブランチがないことは、先端の取得で確かめ直す
            // （`rev-parse --verify -q` が code 1 のときだけ「ない」。失敗〔headUnknown〕・先端あり なら、gone にしない）。
            const head = await headFields(nodeId);
            if (head.headUnknown === true || head.headCommit !== undefined) return undefined;
            return { worktreePath: path, merged: false, clean: true, gone: true as const };
          }
          return undefined;
        }
        const real = realOrUndefined(path);
        if (real === undefined) return undefined;
        const clean = await isClean(path);
        let merged = false;
        const up = await git(["rev-parse", "--abbrev-ref", `${branchOf(nodeId)}@{upstream}`]);
        if (up.code === 0 && up.stdout.trim() !== "") {
          const anc = await git([
            "merge-base",
            "--is-ancestor",
            branchOf(nodeId),
            up.stdout.trim(),
          ]);
          merged = anc.code === 0;
        }
        // 祖先判定が偽でも、統合済みの証拠の先端が、いまの先端と一致すれば統合済み（スカッシュ後）。
        let mergedBy: "ancestor" | "evidence" | undefined = merged ? "ancestor" : undefined;
        if (
          !merged &&
          opts?.mergeEvidenceTip !== undefined &&
          (await tipOfBranch(branchOf(nodeId))) === opts.mergeEvidenceTip
        ) {
          merged = true;
          mergedBy = "evidence";
        }
        // 親のブランチ（上流）の名前。CLI が、PR の base ブランチと突き合わせる（別のブランチへのマージを証拠にしない）。
        const full = await git([
          "rev-parse",
          "--symbolic-full-name",
          `${branchOf(nodeId)}@{upstream}`,
        ]);
        const base = baseBranchOf(full.code === 0 ? full.stdout.trim() : "");
        return {
          merged,
          ...(mergedBy !== undefined ? { mergedBy } : {}),
          ...(base === undefined ? {} : { base }),
          branch: branchOf(nodeId),
          clean,
          worktreePath: real,
          ...(await headFields(nodeId)),
        };
      }),

    removeWorktree: (nodeId, { expectedPath, force, onTip, mergeEvidenceTip }) =>
      serial(async () => {
        const path = pathOf(nodeId);
        // 判定に使った実パスと、削除するパスが同じか（違えば何もしない）。
        if (typeof expectedPath !== "string" || expectedPath !== (realOrUndefined(path) ?? path)) {
          return fail(
            "pathMismatch",
            "判定に使った作業ツリーのパスと、削除するパスが違う",
            "回収の判定をやり直す",
          );
        }
        if (options.adoptedOf?.(nodeId) !== undefined) {
          // 採用した作業ツリー（#163）: 作業ツリーもブランチも消さない（預かっていただけ）。子の印だけ片付ける。
          const gitDir = await git(["rev-parse", "--absolute-git-dir"], path);
          if (gitDir.code === 0 && gitDir.stdout.trim() !== "") {
            try {
              unlinkSync(join(gitDir.stdout.trim(), CHILD_WORKTREE_MARKER));
            } catch {
              // 印がなければ、片付けるものはない
            }
          }
          return { ok: true as const, value: undefined };
        }
        const registered = await isRegistered(nodeId);
        if (typeof registered !== "boolean") {
          return fail(
            "gitFailed",
            gitCause("作業ツリーの一覧を取得できなかった", registered.missing),
            "git の状態を確認する",
          );
        }
        const branch = branchOf(nodeId);
        // 削除の前に、ブランチが統合済みか確かめる。統合されていなければ、作業ツリーも消さずに失敗する（成果を失わない）。
        // `force`（破棄の判断を経た停止ノード。判断は呼び出し側が行う）のときは、成果を捨てる判断済みなので、確かめない。
        // 祖先判定が通らなくても、統合済みの証拠（PR の head・人の宣言）の先端が、いまの先端と一致すれば通す（`byEvidence`）。
        // 証拠による削除は、先端を保管してから `-D` で消す。`force`（破棄）とは別の経路。
        let byEvidence = false;
        if (force !== true && (registered || (await branchExists(branch)))) {
          const up = await git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
          const anc =
            up.code === 0 && up.stdout.trim() !== ""
              ? await git(["merge-base", "--is-ancestor", branch, up.stdout.trim()])
              : undefined;
          if (
            (anc === undefined || anc.code !== 0) &&
            mergeEvidenceTip !== undefined &&
            (await tipOfBranch(branch)) === mergeEvidenceTip
          ) {
            byEvidence = true;
          } else if (anc === undefined || anc.code !== 0) {
            return fail(
              "branchNotMerged",
              `ブランチ ${branch} が、上流に統合済みと確認できない（作業ツリーもブランチも残した）`,
              "成果を統合してから、もう一度回収する",
            );
          }
        }
        // `git worktree remove` は、gitignore の対象（`.env` など）を黙って消すので、消す前に、同じ規則できれいか確かめる。
        if (force !== true && registered && !(await isClean(path))) {
          return fail(
            "removeFailed",
            "作業ツリーに、未保存の変更・未追跡のファイル・再生成できない gitignore の対象がある（消さなかった）",
            "作業ツリーの中身を確認する（強制は削除しない）",
          );
        }
        // 強制で消す前に、ブランチの先端を残す（捨てる成果を、あとから辿れるように）。
        // 先端は、`refs/touryou/discarded/<名前>` に付け替えて保管する（gc で消えない）。保管できなければ、何も消さずに失敗する。
        if ((force === true || byEvidence) && (await branchExists(branch))) {
          const tip = await git(["rev-parse", `refs/heads/${branch}`]);
          const sha = tip.stdout.trim();
          if (tip.code === 0 && isCommitSha(sha)) {
            // 証拠による削除は、保管する先端が証拠の先端と同じか確かめる（判定のあとに動いていたら、何も消さない）。
            if (byEvidence && sha !== mergeEvidenceTip) {
              return fail(
                "tipMoved",
                `ブランチ ${branch} の先端が、統合済みの証拠の記録後に動いた（何も消さなかった）`,
                "回収の判定をやり直す（新しい先端には、証拠が要る）",
              );
            }
            const kept = await keepDiscarded(nodeId, sha);
            if (!kept.ok) return kept;
            onTip?.(sha, kept.value.ref);
          } else {
            // どの経路でも、保管できなければ、何も消さずに失敗する（先端を取得できない・コミットの形でない、など）。
            return fail(
              "keepFailed",
              "消すブランチの先端を取得できなかった（何も消さなかった）",
              "git の状態を確認する",
            );
          }
        }
        if (registered) {
          // `--force` は、`force`（破棄の判断を経たノード）のときだけ。登録されていない場所は、強制でも消さない（下）。
          const r = await git(
            force === true ? ["worktree", "remove", "--force", path] : ["worktree", "remove", path],
          );
          if (r.code !== 0) {
            return fail(
              "removeFailed",
              `作業ツリーを消せなかった（未保存の変更などがある）: ${r.stderr.trim()}`,
              "作業ツリーの中身を確認する（強制は削除しない）",
            );
          }
        } else if (dirExists(path)) {
          return fail(
            "worktreeConflict",
            `${path} は、登録されていない作業ツリー（消さない）`,
            "場所の中身を確認して、人間が片付ける",
          );
        }
        if (await branchExists(branch)) {
          // 証拠による削除は、実行直前に先端が証拠と一致することを照合する（動いていたら、何も消さない）。
          if (byEvidence && (await tipOfBranch(branch)) !== mergeEvidenceTip) {
            return fail(
              "tipMoved",
              `ブランチ ${branch} の先端が、統合済みの証拠の記録後に動いた（ブランチを残した）`,
              "回収の判定をやり直す（新しい先端には、証拠が要る）",
            );
          }
          // 統合済みだけ（`-d`）。`-D` は `force` のときだけ。証拠による削除は、証拠の先端を古い値とする
          // `update-ref -d`（先端が動いていれば、git が断る。確かめと削除の隙間がない）。先端は保管済み。
          const r =
            byEvidence && mergeEvidenceTip !== undefined
              ? await git(["update-ref", "-d", `refs/heads/${branch}`, mergeEvidenceTip])
              : await git(["branch", force === true ? "-D" : "-d", branch]);
          if (r.code === 0 && byEvidence) {
            // `git branch -D` と同じく、ブランチの設定（上流など）も片付ける。無ければ失敗するが、問題ない。
            await git(["config", "--remove-section", `branch.${branch}`]);
          }
          if (r.code !== 0) {
            if (force === true || byEvidence) {
              return fail(
                "removeFailed",
                `作業ツリーは消えたが、ブランチ ${branch} だけ残った: ${r.stderr.trim().slice(0, 200)}`,
                "もう一度回収する（残りだけを消す）",
              );
            }
            return fail(
              "branchNotMerged",
              `ブランチ ${branch} に、統合されていない成果がある（残した）: ${r.stderr.trim()}`,
              "成果を統合してから、もう一度回収する",
            );
          }
        }
        return { ok: true as const, value: undefined };
      }),
  };
  return { ok: true, value: ports };
}
