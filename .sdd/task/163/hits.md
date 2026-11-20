# 検索結果（packages 配下・1 語 40 件まで）
## pathOf\(
packages/daemon/src/children-dir.ts:97:  pathOf(nodeId: string): string;
packages/daemon/src/compose.ts:1357:    const command = `${touryou} child hook --dir ${shellWord(childrenDirs.pathOf(nodeId))} --url ${shellWord(url)}`;
packages/daemon/src/compose.ts:1465:      drawer = await realpath(childrenDirs.pathOf(nodeId));
packages/daemon/src/git-ports.ts:356:    return list.get(pathOf(nodeId)) === branchOf(nodeId);
packages/daemon/src/git-ports.ts:421:    const path = pathOf(nodeId);
packages/daemon/src/git-ports.ts:718:        const path = pathOf(nodeId);
packages/daemon/src/git-ports.ts:822:        (await isRegistered(nodeId)) === true ? realOrUndefined(pathOf(nodeId)) : undefined,
packages/daemon/src/git-ports.ts:827:        const path = pathOf(nodeId);
packages/daemon/src/git-ports.ts:870:        const path = pathOf(nodeId);
packages/daemon/test/children-dir.test.ts:222:    expect(d.pathOf("a")).toBe(dir);
## branchOf\(
packages/daemon/src/git-ports.ts:356:    return list.get(pathOf(nodeId)) === branchOf(nodeId);
packages/daemon/src/git-ports.ts:409:    const r = await git(["rev-parse", "--verify", "-q", `${branchOf(nodeId)}^{commit}`]);
packages/daemon/src/git-ports.ts:422:    const branch = branchOf(nodeId);
packages/daemon/src/git-ports.ts:636:        const branch = branchOf(nodeId);
packages/daemon/src/git-ports.ts:719:        const branch = branchOf(nodeId);
packages/daemon/src/git-ports.ts:750:          parentBranch = branchOf(parentId);
packages/daemon/src/git-ports.ts:832:          if (!dirExists(path) && (await branchExists(branchOf(nodeId)))) {
packages/daemon/src/git-ports.ts:855:        const up = await git(["rev-parse", "--abbrev-ref", `${branchOf(nodeId)}@{upstream}`]);
packages/daemon/src/git-ports.ts:860:            branchOf(nodeId),
packages/daemon/src/git-ports.ts:887:        const branch = branchOf(nodeId);
## cwdOf
packages/daemon/src/api/handlers/cli-bind-check.ts:22:  readonly cwdOf: (nodeId: string) => Promise<string | undefined>;
packages/daemon/src/api/handlers/cli-bind-check.ts:46:      const tree = await deps.cwdOf(nodeId);
packages/daemon/src/api/handlers/index.ts:93:  // （scope.extend・scope.decide）も有効になる（作業ツリーの取得 `cwdOf`・根の範囲 `rootScope` を共有する）。
packages/daemon/src/api/handlers/index.ts:192:            cwdOf: spawn.ports.cwdOf,
packages/daemon/src/api/handlers/pause-handlers.ts:70:    cwdOf(nodeId: string): Promise<string | undefined>;
packages/daemon/src/api/handlers/pause-handlers.ts:240:    const cwd = await ports.cwdOf(target).catch(() => undefined);
packages/daemon/src/api/handlers/scope-handlers.ts:49:  readonly cwdOf: (nodeId: string) => Promise<string | undefined>;
packages/daemon/src/api/handlers/scope-handlers.ts:116:      deps.cwdOf(ext.nodeId).catch(() => undefined),
packages/daemon/src/api/handlers/scope-handlers.ts:117:      deps.cwdOf(node.parentId).catch(() => undefined),
packages/daemon/src/api/handlers/spawn-handlers.ts:7: * 1. 親（動作中の統合ノード）・依存先（呼び出し元の部分木のノード）・親の作業ツリー（`cwdOf`。取得できなければ失敗＝安全側）
packages/daemon/src/api/handlers/spawn-handlers.ts:60:  cwdOf(nodeId: string): Promise<string | undefined>;
packages/daemon/src/api/handlers/spawn-handlers.ts:446:      parentCwd = await ports.cwdOf(parentId);
packages/daemon/src/api/hook.ts:82:  const cwdOf = text(b.cwd, 4096);
packages/daemon/src/api/hook.ts:90:        ...(cwdOf === undefined ? {} : { cwd: cwdOf }),
packages/daemon/src/api/hook.ts:108:        ...(cwdOf === undefined ? {} : { cwd: cwdOf }),
packages/daemon/src/api/session-binding.ts:50:  readonly cwdOf: (nodeId: string) => Promise<string | undefined>;
packages/daemon/src/api/session-binding.ts:92:      const worktree = await deps.cwdOf(node.id).catch(() => undefined);
packages/daemon/src/compose.ts:12: * - ポートの `cwdOf` は、根のノードだけ設定の `rootCwd` を返し、ほかはポートに任せる。
packages/daemon/src/compose.ts:189:  cwdOf(nodeId: string): Promise<string | undefined>;
packages/daemon/src/compose.ts:1450:    const tree = await deps.worktree.cwdOf(nodeId).catch(() => undefined);
packages/daemon/src/compose.ts:1601:    const tree = await deps.worktree.cwdOf(nodeId).catch(() => undefined);
packages/daemon/src/compose.ts:1687:  const cwdOf = async (nodeId: string): Promise<string | undefined> =>
packages/daemon/src/compose.ts:1688:    nodeId === config.rootNodeId ? config.rootCwd : deps.worktree.cwdOf(nodeId);
packages/daemon/src/compose.ts:1714:    cwdOf,
packages/daemon/src/compose.ts:1893:  const sessionBindings = createSessionBindings({ log, cwdOf: (id) => deps.worktree.cwdOf(id) });
packages/daemon/src/compose.ts:2052:      ? { bindWorktreeOk: createBindWorktreeCheck({ cwdOf: (id) => deps.worktree.cwdOf(id) }) }
packages/daemon/src/compose.ts:2127:          cwdOf,
packages/daemon/src/git-ports.ts:220:  cwdOf(nodeId: string): Promise<string | undefined>;
packages/daemon/src/git-ports.ts:820:    cwdOf: (nodeId) =>
packages/daemon/src/reconcile.ts:53:  readonly cwdOf: (nodeId: string) => Promise<string | undefined>;
packages/daemon/src/reconcile.ts:160:      const cwd = await deps.cwdOf(n.id);
packages/daemon/src/sdk/lsof-probe.ts:79:function cwdOf(p: LsofProcess): string | undefined {
packages/daemon/src/sdk/lsof-probe.ts:118:      const cwd = cwdOf(p);
packages/daemon/test/api/cli-bind-server.test.ts:58:      cwdOf: async (id) => TREES[id],
packages/daemon/test/api/handlers/answer-delivery.test.ts:125:    ports: { cwdOf: async (id) => `/wt/${id}` },
packages/daemon/test/api/handlers/create-handlers.test.ts:16:    cwdOf: async () => "/wt/x",
packages/daemon/test/api/handlers/pause-handlers.test.ts:122:    ports: { cwdOf: async (id) => `/wt/${id}` },
packages/daemon/test/api/handlers/scheduler.test.ts:100:    cwdOf: async (id) => `${WT}/${id}`,
packages/daemon/test/api/handlers/scope-handlers.test.ts:95:    cwdOf: async (id) => `/wt/${id}`,
packages/daemon/test/api/handlers/spawn-handlers.test.ts:116:    cwdOfParent: `${WT}/m1` as string | undefined,
## CHILD_WORKTREE_MARKER
packages/cli/src/hook.ts:91: * touryou の子の作業ツリーの印（daemon の `CHILD_WORKTREE_MARKER` と同じ）。作業ツリーの git のディレクトリ
packages/daemon/src/git-ports.ts:36: * `packages/mcp/src/child-marker.ts` の `CHILD_WORKTREE_MARKER` と同じ値にする。
packages/daemon/src/git-ports.ts:38:export const CHILD_WORKTREE_MARKER = "touryou-child";
packages/daemon/src/git-ports.ts:793:            writeFileSync(join(gitDir.stdout.trim(), CHILD_WORKTREE_MARKER), `${nodeId}\n`, {
packages/daemon/test/child-marker-real-git.test.ts:6:import { CHILD_WORKTREE_MARKER, createGitPorts, nodeGit } from "../src/git-ports.js";
packages/daemon/test/child-marker-real-git.test.ts:42:    expect(readFileSync(join(dir, CHILD_WORKTREE_MARKER), "utf8").trim()).toBe("c1");
packages/daemon/test/child-marker-real-git.test.ts:45:    expect(() => readFileSync(join(rootDir, CHILD_WORKTREE_MARKER))).toThrow();
packages/mcp/src/child-marker.ts:24:/** `packages/daemon/src/git-ports.ts` の `CHILD_WORKTREE_MARKER` と同じ値。 */
packages/mcp/src/child-marker.ts:25:export const CHILD_WORKTREE_MARKER = "touryou-child";
packages/mcp/src/child-marker.ts:64:    const path = join(gitDir, CHILD_WORKTREE_MARKER);
packages/mcp/test/child-marker.test.ts:7:import { CHILD_WORKTREE_MARKER, detectOpenMode } from "../src/child-marker.js";
packages/mcp/test/child-marker.test.ts:110:      writeFileSync(join(dir, CHILD_WORKTREE_MARKER), "node-a\n");
## touryou-child
packages/cli/src/bin.ts:248:      newRequestId: deps.newRequestId ?? (() => `touryou-child-${randomUUID()}`),
packages/cli/src/hook.ts:92: * （`git rev-parse --absolute-git-dir`）の直下の `touryou-child`。中身はノード ID だが、ここでは、あるかどうかだけを見る。
packages/cli/src/hook.ts:95:export const CHILD_MARK = "touryou-child";
packages/cli/test/child.test.ts:35:  const base = mkdtempSync(join(tmpdir(), "touryou-child-"));
packages/cli/test/child.test.ts:484:    const base = mkdtempSync(join(tmpdir(), "touryou-child-"));
packages/cli/test/hook-session.test.ts:134:  // 仮の印: git worktree の .git（ファイル）が指す git のディレクトリの直下の touryou-child
packages/cli/test/hook-session.test.ts:139:  const marks = new Set(["/repo/.git/worktrees/a/touryou-child"]);
packages/cli/test/hook-session.test.ts:199:    const exists = (p: string) => p === "/w/x/../repo/.git/worktrees/x/touryou-child";
packages/cli/test/hook-session.test.ts:209:  const marks = new Set(["/repo/.git/worktrees/a/touryou-child"]);
packages/cli/test/hook-session.test.ts:317:  const exists = (p: string) => p === "/repo/.git/worktrees/a/touryou-child" || p in tree;
packages/cli/test/hook-state-files.test.ts:41:  writeFileSync(join(gitA, "touryou-child"), "node-a\n");
packages/daemon/src/bind-code-file.ts:4: * - 置き場: 子の作業ツリーの git のディレクトリ（`<作業ツリー>/.git` のファイルの `gitdir:` の先。印 `touryou-child` と同じ所。
packages/daemon/src/compose.ts:1617:    // 作業ツリーの git のディレクトリ（印 touryou-child がある）と、作業ツリーの .git は、書き込み・削除を禁じる（rm・mv・ln・
packages/daemon/src/git-ports.ts:38:export const CHILD_WORKTREE_MARKER = "touryou-child";
packages/daemon/test/children-dir.test.ts:32:  const d = mkdtempSync(join(tmpdir(), "touryou-children-"));
packages/daemon/test/sdk/hook-policy-cli-child.test.ts:74:    ["Write", { file_path: `${G}/touryou-child`, content: "x" }],
packages/daemon/test/sdk/hook-policy-cli-child.test.ts:82:    `rm ${G}/touryou-child`,
packages/daemon/test/sdk/hook-policy-cli-child.test.ts:84:    `mv ${G}/touryou-child /tmp/x`,
packages/daemon/test/sdk/hook-policy-cli-child.test.ts:85:    `ln -sf /tmp/x ${G}/touryou-child`,
packages/daemon/test/sdk/hook-policy-cli-child.test.ts:86:    `echo x > ${G}/touryou-child`,
packages/daemon/test/sdk/hook-policy-cli-child.test.ts:87:    `cp /tmp/x ${G}/touryou-child`,
packages/daemon/test/sdk/hook-policy-cli-child.test.ts:114:    `dd if=/dev/zero of=${G}/touryou-child`,
packages/daemon/test/sdk/hook-policy-cli-child.test.ts:115:    `curl --output=${G}/touryou-child http://127.0.0.1/`,
packages/daemon/test/sdk/hook-policy-cli-child.test.ts:116:    `echo x | tee ${G}/touryou-child`,
packages/daemon/test/sdk/hook-policy-cli-child.test.ts:118:    `cp /tmp/x ${G}/touryou-child`,
packages/daemon/test/sdk/hook-policy-cli-child.test.ts:119:    `install /tmp/x ${G}/touryou-child`,
packages/daemon/test/sdk/hook-policy-cli-child.test.ts:120:    `truncate -s 0 ${G}/touryou-child`,
packages/daemon/test/sdk/hook-policy.test.ts:30:    expect((await decide("Skill", { skill: "touryou-child-skills:child" })).allow).toBe(true);
packages/daemon/test/startup-real-git.test.ts:204:            join(git(t, "rev-parse", "--absolute-git-dir"), "touryou-child"),
packages/mcp/src/child-marker.ts:5: *   印のファイル `touryou-child`（中身はノードの ID だけ。秘密は入れない）を置く（`packages/daemon/src/git-ports.ts`）。
packages/mcp/src/child-marker.ts:25:export const CHILD_WORKTREE_MARKER = "touryou-child";
packages/mcp/src/stdio.ts:102:  /** 印（`touryou-child`）に書かれたノードの ID（`child_bind` を引数なしで呼んだときに使う）。 */
packages/mcp/test/child-marker.test.ts:36:      { "/w/a/.git": "file", "/r/.git/worktrees/a/touryou-child": "file" },
packages/mcp/test/child-marker.test.ts:39:        "/r/.git/worktrees/a/touryou-child": "node-a\n",
packages/mcp/test/child-marker.test.ts:63:    const base = { "/w/a/.git": "file" as K, "/g/touryou-child": "file" as K };
packages/mcp/test/child-marker.test.ts:67:        fs(base, { "/w/a/.git": "gitdir: /g", "/g/touryou-child": new Error("EACCES") }),
packages/mcp/test/child-marker.test.ts:71:      detectOpenMode("/w/a", fs(base, { "/w/a/.git": "gitdir: /g", "/g/touryou-child": "../x y" })),
packages/mcp/test/child-marker.test.ts:76:        fs({ "/w/a/.git": "file", "/g/touryou-child": "unknown" }, { "/w/a/.git": "gitdir: /g" }),
packages/mcp/test/child-marker.test.ts:146:          kindOf: (p) => (p === "/w/a/.git" || p === "/g/touryou-child" ? "file" : "none"),
packages/mcp/test/child-marker.test.ts:178:      { "/w/a/sub/.git": "file", "/w/a/.git": "file", "/r/.git/worktrees/a/touryou-child": "file" },
## latestLaunch
packages/daemon/src/compose.ts:121:import { latestLaunch, ParentRequestCliAdapter } from "./sdk/cli-adapter.js";
packages/daemon/src/compose.ts:862:        const launch = latestLaunch(st, n.id);
packages/daemon/src/compose.ts:909:    const launch = latestLaunch(st, nodeId);
packages/daemon/src/compose.ts:931:      if (r.kind !== "launch" || latestLaunch(log.state(), r.nodeId)?.requestRef !== r.requestRef)
packages/daemon/src/compose.ts:948:      const launch = latestLaunch(st0, n.id);
packages/daemon/src/compose.ts:1994:                const launch = latestLaunch(log.state(), nodeId);
packages/daemon/src/compose.ts:2062:      const launch = latestLaunch(log.state(), nodeId);
packages/daemon/src/sdk/cli-adapter.ts:106:export const latestLaunch = (state: OrchState, nodeId: string) =>
packages/daemon/src/sdk/cli-adapter.ts:117:    const launch = latestLaunch(this.deps.log.state(), nodeId);
packages/daemon/src/sdk/cli-adapter.ts:209:    const launch = latestLaunch(state, nodeId);
packages/daemon/src/sdk/cli-adapter.ts:290:    this.discardCode(nodeId, latestLaunch(this.deps.log.state(), nodeId)?.worktree, true);
## has\(
packages/cli/src/child.ts:328:  if (!LOOPBACK.has(u.hostname) || u.username !== "" || u.password !== "") return undefined;
packages/cli/src/child.ts:713:  if (TEXT_BODY.has(kind)) {
packages/cli/src/commands.ts:651:  const json = flags.has("--json");
packages/cli/src/commands.ts:700:  (ANSWER_DELIVERABLE_STATES as ReadonlySet<string>).has(state);
packages/cli/src/commands.ts:756:  if (flags.has("--json")) {
packages/cli/src/commands.ts:840:  if (!flags.has("--yes")) {
packages/cli/src/commands.ts:948:  const detail = flags.has("--detail");
packages/cli/src/commands.ts:1023:      if (VALUE_FLAGS.has(a)) {
packages/cli/src/commands.ts:1077:  if (flags.has("--tombstone") && flags.has("--no-tombstone")) {
packages/cli/src/commands.ts:1128:    if (!flags.has("--yes")) {
packages/cli/src/commands.ts:1241:    if (!flags.has("--yes")) {
packages/cli/src/commands.ts:1346:    if (!flags.has("--yes")) {
packages/cli/src/commands.ts:1350:        stderr: `${values.has("--expect") ? "--expect は、表示だけ（実行には --yes が要る）。" : ""}破棄の判断は取り消せない（停止したノードの作業ツリーとブランチが、強制して消える）。上の内容でよければ、
packages/cli/src/commands.ts:1382:  const tombstone = flags.has("--tombstone")
packages/cli/src/commands.ts:1384:    : flags.has("--no-tombstone")
packages/cli/src/commands.ts:1408:  if (flags.has("--dry-run"))
packages/cli/src/commands.ts:1418:  if (!flags.has("--yes")) {
packages/cli/src/commands.ts:1422:      stderr: `${values.has("--expect") ? "--expect は、表示だけ（実行には --yes が要る）。" : ""}最終削除は取り消せない。上の対象でよければ、表示の値を付けて再実行する: "$HOME/.touryou/c
packages/cli/src/http-client.ts:29:      if (!r.ok && UNKNOWN.has(r.error.code)) throw new Error(`${r.error.code}: ${r.error.cause}`);
packages/cli/test/hook-session.test.ts:145:  const exists = (p: string) => marks.has(p) || p in tree;
packages/cli/test/hook-session.test.ts:215:  const exists = (p: string) => marks.has(p) || p in tree;
packages/cli/test/launchd.test.ts:287:  it.skipIf(!has("plutil", ["-help"]))("plutil -lint が通る", async () => {
packages/cli/test/launchd.test.ts:295:  it.skipIf(!has("python3", ["--version"]))(
packages/cli/test/parent-readonly-tools.test.ts:28:    for (const t of PARENT_READONLY_TOOL_NAMES) expect(INTEGRATOR_TOOLS.has(t), t).toBe(true);
packages/core/src/digest.ts:124:    scope.has(ownerId) && stateOf.get(ownerId) !== "archived";
packages/core/src/events.ts:1188:  while (cur !== null && !out.has(cur)) {
packages/core/src/events.ts:1208:    return s !== undefined && COMPLETED_STATES.has(s);
packages/core/src/events.ts:1266:      if (d.nodeIdx.has(nodeId)) {
packages/core/src/events.ts:1323:        if (dep === nodeId || !d.nodeIdx.has(dep)) {
packages/core/src/events.ts:1331:        if (ancestors.has(dep)) {
packages/core/src/events.ts:1453:        !SCOPE_VIOLATION_REASONS.has(reason) ||
packages/core/src/events.ts:1564:      if (d.inboxIds.has(id)) {
packages/core/src/events.ts:1612:      if (!RECORDABLE_STATES.has(node.state)) return notRecordable(seq, node, "node.toolDenied");
packages/core/src/events.ts:1643:      if (!RECORDABLE_STATES.has(node.state)) return notRecordable(seq, node, "node.exited");
packages/core/src/events.ts:1685:      if (d.reportIdx.has(reportId)) {
packages/core/src/events.ts:1755:          if (!below.has(target)) {
packages/core/src/events.ts:1763:      if (d.decisionIdx.has(decisionId)) {
packages/core/src/events.ts:1847:      if (!RECORDABLE_STATES.has(node.state)) return notRecordable(seq, node, "追加指示");
packages/core/src/events.ts:1946:      const alive = nodeIds.find((id) => d.nodeIdx.has(id));
packages/core/src/events.ts:2238:      if (d.extensionIdx.has(extensionId)) {
## reconcile
packages/daemon/src/api/handlers/context.ts:86:export const waitRequestKey = (decisionId: string): string => `reconcile-wait-${decisionId}`;
packages/daemon/src/api/handlers/pause-handlers.ts:139:    const reconciled =
packages/daemon/src/api/handlers/pause-handlers.ts:145:    if (!mine(pauseRequestId(decision.decisionId, target)) && !reconciled) return false;
packages/daemon/src/compose.ts:120:import { reconcileOnStartup } from "./reconcile.js";
packages/daemon/src/compose.ts:2124:        const outcomes = await reconcileOnStartup({
packages/daemon/src/compose.ts:2133:          onFailure: (nodeId, cause) => note("reconcileFailure", { nodeId, cause }),
packages/daemon/src/compose.ts:2135:        for (const o of outcomes) note("reconciled", { ...o });
packages/daemon/src/external-check.ts:4: * - 依頼は、起動時の照合（`reconcile.ts`）が、未解決のものを常に 1 件だけ置く: 未解決の古い依頼（前の版の文面を含む）は、
packages/daemon/src/reconcile.ts:78:export async function reconcileOnStartup(deps: ReconcileDeps): Promise<ReconcileOutcome[]> {
packages/daemon/src/reconcile.ts:96:    const key = `reconcile-external-${run}`;
packages/daemon/src/reconcile.ts:136:      `reconcile-stale-${run}`,
packages/daemon/src/reconcile.ts:175:    const key = `reconcile-${n.id}-${run}`;
packages/daemon/src/sdk/cli-adapter.ts:9: * - `has`: 起動の依頼の記録があるノード（daemon の外で動く子。再起動の後の整合〔reconcile〕で、プロセスがないことを理由に
packages/daemon/test/api/stale-inbox.test.ts:15:import { EXTERNAL_CHECK_SUMMARY, reconcileOnStartup } from "../../src/reconcile.js";
packages/daemon/test/api/stale-inbox.test.ts:99:    reconcileOnStartup({
packages/daemon/test/api/stale-inbox.test.ts:116:    // running の s は、reconcile 自身が失敗を足す（プロセスなし）ので、その前の項目 id で見る
packages/daemon/test/api/stale-inbox.test.ts:138:    await reconcileOnStartup({
packages/daemon/test/compose.test.ts:508:describe("createDaemon（起動時の整合。待ち受けの前に reconcileOnStartup を呼ぶ）", () => {
packages/daemon/test/reconcile-resume.test.ts:17:import { reconcileOnStartup } from "../src/reconcile.js";
packages/daemon/test/reconcile-resume.test.ts:112:  const reconcile = () =>
packages/daemon/test/reconcile-resume.test.ts:113:    reconcileOnStartup({
packages/daemon/test/reconcile-resume.test.ts:136:  return { log, ev, ask, reconcile, answer, calls, flags, s: () => log.state() };
packages/daemon/test/reconcile-resume.test.ts:144:    await r.reconcile();
packages/daemon/test/reconcile-resume.test.ts:166:    await r.reconcile();
packages/daemon/test/reconcile-resume.test.ts:190:    await r.reconcile();
packages/daemon/test/reconcile-resume.test.ts:199:    await d.reconcile();
packages/daemon/test/reconcile-resume.test.ts:216:    await r.reconcile();
packages/daemon/test/reconcile-resume.test.ts:255:    await reconcileOnStartup({
packages/daemon/test/reconcile.test.ts:13:import { EXTERNAL_CHECK_SUMMARY, reconcileOnStartup } from "../src/reconcile.js";
packages/daemon/test/reconcile.test.ts:61:    reconcileOnStartup({
packages/daemon/test/reconcile.test.ts:84:describe("reconcileOnStartup（再起動の後、記録と実際のプロセスを合わせる）", () => {
packages/daemon/test/reconcile.test.ts:289:    await reconcileOnStartup({
packages/daemon/test/reconcile.test.ts:333:    await reconcileOnStartup({
packages/daemon/test/reconcile.test.ts:402:    await reconcileOnStartup({
## cli-bind-check
packages/daemon/src/compose.ts:48:import { createBindWorktreeCheck } from "./api/handlers/cli-bind-check.js";
packages/daemon/test/api/cli-bind-server.test.ts:5:import { createBindWorktreeCheck } from "../../src/api/handlers/cli-bind-check.js";
## SUBTREE_RULES
packages/core/src/contract.ts:613:export const SUBTREE_RULES: Readonly<Record<SubtreeOperation, SubtreeRule>> = {
packages/core/src/contract.ts:634:export const SUBTREE_SCOPED_OPERATIONS = Object.keys(SUBTREE_RULES) as readonly SubtreeOperation[];
packages/core/src/contract.ts:637: * 統合ノードの操作の分類（型で網羅）。`subtree`: `SUBTREE_RULES` で判定する。`callerFiltered`: 呼び出し側の部分木に
packages/core/test/contract.test.ts:23:  SUBTREE_RULES,
packages/core/test/contract.test.ts:133:    expect(SUBTREE_RULES).toEqual({
packages/core/test/contract.test.ts:153:    expect([...SUBTREE_SCOPED_OPERATIONS].sort()).toEqual(Object.keys(SUBTREE_RULES).sort());
packages/core/test/t13e.test.ts:18:  SUBTREE_RULES,
packages/core/test/t13e.test.ts:383:    expect(SUBTREE_RULES["scope.decide"]).toBe("strictDescendant");
packages/daemon/src/api/authorize.ts:13: * - `authorizeScope`: 統合ノードの操作は `INTEGRATOR_OPERATION_CLASS` で分類する。`subtree` は `SUBTREE_RULES` の規則
packages/daemon/src/api/authorize.ts:32:  SUBTREE_RULES,
packages/daemon/src/api/authorize.ts:143:  const rule = SUBTREE_RULES[op as SubtreeOperation];
packages/daemon/src/api/handlers/parent-request-handlers.ts:18: * - 直接の親か人間だけ（`SUBTREE_RULES` の directChild。窓口の `authorize` が適用する）。
packages/daemon/src/api/handlers/runtime-handlers.ts:30:  SUBTREE_RULES,
packages/daemon/src/api/handlers/runtime-handlers.ts:103: * (3) 呼び出し元との関係（`SUBTREE_RULES`。例: 完了の判定は直接の親だけ、自分自身には何もない）。
packages/daemon/src/api/handlers/runtime-handlers.ts:137:    const rule = SUBTREE_RULES[op as SubtreeOperation];
packages/daemon/src/api/handlers/runtime-handlers.ts:154:  /** 認可（`SUBTREE_RULES`）の二重の備え: 対象は、呼び出した統合ノードの、自分を含まない子孫だけ。 */
packages/daemon/test/api/authorize.test.ts:9:  SUBTREE_RULES,
packages/daemon/test/api/authorize.test.ts:297:  it("SUBTREE_SCOPED_OPERATIONS は SUBTREE_RULES のキー", () => {
packages/daemon/test/api/authorize.test.ts:298:    expect([...SUBTREE_SCOPED_OPERATIONS].sort()).toEqual(Object.keys(SUBTREE_RULES).sort());
packages/daemon/test/api/handlers/runtime-handlers.test.ts:685:  it("呼び出し元の部分木の規則（SUBTREE_RULES）で絞る。子のノードには、review（直接の子）はあるが、自分自身には何もない", async () => {
## INTEGRATOR_OPERATION_CLASS
packages/core/src/contract.ts:610: * 型で網羅を保証する（統合ノードの操作を足すと、ここか `INTEGRATOR_OPERATION_CLASS` の例外に足すまでコンパイルできない）。
packages/core/src/contract.ts:641:export const INTEGRATOR_OPERATION_CLASS: Readonly<
packages/core/test/contract.test.ts:13:  INTEGRATOR_OPERATION_CLASS,
packages/core/test/contract.test.ts:118:      expect(["subtree", "callerFiltered", "denied"], op).toContain(INTEGRATOR_OPERATION_CLASS[op]);
packages/core/test/contract.test.ts:120:    expect(Object.keys(INTEGRATOR_OPERATION_CLASS).sort()).toEqual(
packages/core/test/contract.test.ts:123:    expect(INTEGRATOR_OPERATION_CLASS["inbox.fetch"]).toBe("callerFiltered");
packages/core/test/contract.test.ts:127:    expect(INTEGRATOR_OPERATION_CLASS["tree.list"]).toBe("callerFiltered");
packages/core/test/contract.test.ts:129:    expect(INTEGRATOR_OPERATION_CLASS["scope.decide"]).toBe("subtree");
packages/core/test/contract.test.ts:155:      expect(INTEGRATOR_OPERATION_CLASS[op], op).toBe("subtree");
packages/core/test/loss.test.ts:4:  INTEGRATOR_OPERATION_CLASS,
packages/core/test/loss.test.ts:17:    expect(INTEGRATOR_OPERATION_CLASS["node.reclaimPreview"]).toBe("subtree");
packages/core/test/t13e.test.ts:9:  INTEGRATOR_OPERATION_CLASS,
packages/core/test/t13e.test.ts:382:    expect(INTEGRATOR_OPERATION_CLASS["scope.decide"]).toBe("subtree");
packages/daemon/src/api/authorize.ts:13: * - `authorizeScope`: 統合ノードの操作は `INTEGRATOR_OPERATION_CLASS` で分類する。`subtree` は `SUBTREE_RULES` の規則
packages/daemon/src/api/authorize.ts:23:  INTEGRATOR_OPERATION_CLASS,
packages/daemon/src/api/authorize.ts:135:  const op = operation as keyof typeof INTEGRATOR_OPERATION_CLASS;
packages/daemon/src/api/authorize.ts:136:  const cls = INTEGRATOR_OPERATION_CLASS[op];
packages/daemon/test/api/authorize.test.ts:4:  INTEGRATOR_OPERATION_CLASS,
packages/daemon/test/api/authorize.test.ts:288:  it("統合ノードの操作は、分類（INTEGRATOR_OPERATION_CLASS）のとおりに判定される", () => {
packages/daemon/test/api/authorize.test.ts:290:      const cls = INTEGRATOR_OPERATION_CLASS[op];
## toolsFor
packages/mcp/src/server.ts:19:  toolsFor,
packages/mcp/src/server.ts:261:      ...(init.pending === true && !deps.bound ? [] : toolsFor(deps.role)).map((t) => ({
packages/mcp/src/tools.ts:115:export function toolsFor(role: McpRole): readonly ToolDefinition[] {
packages/mcp/src/tools.ts:153:  const tools = toolsFor(role);
packages/mcp/test/inbox-response.test.ts:9:import { inboxProblems, MCP_ROLES, nextActionsFor, renderInbox, toolsFor } from "../src/index.js";
packages/mcp/test/inbox-response.test.ts:39:    const exposed = new Set(toolsFor("integrator").map((t) => t.name));
packages/mcp/test/server.test.ts:12:  toolsFor,
packages/mcp/test/server.test.ts:41:      expect(tools.map((t) => t.name)).toEqual([...toolsFor(role).map((t) => t.name), WHOAMI_TOOL]);
packages/mcp/test/session.test.ts:5:import { openSession, type Relay, toolsFor, WHOAMI_TOOL } from "../src/index.js";
packages/mcp/test/session.test.ts:24:        ...toolsFor(role).map((t) => t.name),
packages/mcp/test/tools.test.ts:3:import { MCP_ROLES, type McpRole, operationForTool, toolName, toolsFor } from "../src/index.js";
packages/mcp/test/tools.test.ts:5:const names = (role: McpRole) => toolsFor(role).map((t) => t.name);
packages/mcp/test/tools.test.ts:56:      expect(toolsFor(role as McpRole)).toEqual([]);
packages/mcp/test/tools.test.ts:70:      for (const tool of toolsFor(role)) expect(humanOnly.has(tool.operation)).toBe(false);
packages/mcp/test/tools.test.ts:89:      expect(toolsFor(role).some((t) => t.operation === "node.purge")).toBe(false);
packages/mcp/test/tools.test.ts:95:      expect(toolsFor(role).map((t) => t.operation)).toEqual([...ROLE_OPERATIONS[role]]);
packages/mcp/test/tools.test.ts:102:      const tools = toolsFor(r);
packages/mcp/test/tools.test.ts:105:    const all = MCP_ROLES.flatMap((r) => toolsFor(r));
packages/mcp/test/tools.test.ts:142:    const d = (n: string) => toolsFor("integrator").find((t) => t.name === n)?.description ?? "";
packages/mcp/test/tools.test.ts:163:    expect(toolsFor("child").find((t) => t.name === "scope_extend")?.description).toContain("kind");
packages/mcp/test/tools.test.ts:171:    const d = (n: string) => toolsFor("integrator").find((t) => t.name === n)?.description ?? "";
packages/mcp/test/tools.test.ts:197:      for (const t of toolsFor(role)) {
packages/mcp/test/tools.test.ts:208:      const names = toolsFor(role).map((t) => t.name);
packages/mcp/test/wake-guidance.test.ts:4:import { toolsFor } from "../src/tools.js";
packages/mcp/test/wake-guidance.test.ts:14:    const d = toolsFor("child").find((t) => t.name === "report_progress")?.description ?? "";
## node_bindCode
packages/cli/test/parent-readonly-tools.test.ts:34:      "node_bindCode",
packages/core/src/contract.ts:703: * 「記録（イベント）を書かない」ことの試験が、この一覧を見る。ものを変える道具（書く・起動・停止・判定・回収・`node_bindCode`）と、
packages/core/src/inbox-messages.ts:95:    ja: "子 {node} の紐付けをやり直して（コードが無効。daemon の再起動・期限切れなど）。node_bindCode でコードを出し直し、子に child_bind を引数なしでもう一度呼ばせる",
packages/core/src/inbox-messages.ts:96:    en: "Redo the binding for child {node} (the code is no longer valid, for example after a daemon restart or expiry). Issue a new
packages/daemon/src/ui/app-text.ts:609:    ja: "開くと、子の紐付けが外れることがあります。子が「紐付けをやり直して」と言ったら、統合の会話で、この子の紐付けのコードの出し直し（node_bindCode）を頼んでください。",
packages/daemon/src/ui/app-text.ts:610:    en: "Opening it may unbind the child. If the child asks to be bound again, ask in the integrator's conversation for a new bindi
packages/mcp/src/stdio.ts:415:          "作業を始めずに、会話で人（親）に「紐付けをやり直して」と頼む（親は node_bindCode でコードを出し直す）。出し直されたら、child_bind を引数なしでもう一度呼ぶ",
packages/mcp/src/stdio.ts:443:          "作業を始めずに、会話で人（親）に「紐付けをやり直して」と頼む（daemon も受信箱に出す。親は node_bindCode でコードを出し直す）。出し直されたら、child_bind を引数なしでもう一度呼ぶ",
packages/mcp/test/notify-route.test.ts:96:  it("node_bindCode の転送に parentSessionId を足す（道具の引数には出さない）", async () => {
packages/mcp/test/notify-route.test.ts:104:    const t = tools.find((x) => x.name === "node_bindCode");
packages/mcp/test/notify-route.test.ts:106:    await client.callTool({ name: "node_bindCode", arguments: { nodeId: "a" } });
packages/mcp/test/notify-route.test.ts:127:    await client.callTool({ name: "node_bindCode", arguments: { nodeId: "a" } });
packages/mcp/test/notify-route.test.ts:295:    // 付けないときは、node_bindCode・node_spawn を parentSessionId なしで転送する
packages/mcp/test/notify-route.test.ts:307:    await client.callTool({ name: "node_bindCode", arguments: { nodeId: "a" } });
packages/mcp/test/schemas.test.ts:25:  node_bindCode: { nodeId: "n1" },
packages/mcp/test/tools.test.ts:15:    "node_bindCode",
## "node.created"
packages/core/src/events.ts:58:      readonly type: "node.created";
packages/core/src/events.ts:1260:    case "node.created": {
packages/core/src/purge.ts:119:      case "node.created":
packages/core/test/actor-trust.test.ts:14:  type: "node.created",
packages/core/test/digest.test.ts:24:  ev({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
packages/core/test/events.test.ts:44:  type: "node.created",
packages/core/test/events.test.ts:779:        type: "node.created",
packages/core/test/events.test.ts:1203:      type: "node.created",
packages/core/test/events.test.ts:1464:      type: "node.created",
packages/core/test/hook-unbound.test.ts:20:      type: "node.created",
packages/core/test/hook-unbound.test.ts:25:      type: "node.created",
packages/core/test/inbox-messages.test.ts:33:      type: "node.created",
packages/core/test/lastcommit.test.ts:27:  ev({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
packages/core/test/purge.test.ts:19:) => ev({ type: "node.created", payload: { nodeId, role, parentId, dependsOn } });
packages/core/test/purge.test.ts:198:          (e.type === "node.created" || e.type === "node.stateChanged"),
packages/core/test/purged.test.ts:23:      type: "node.created",
packages/core/test/purged.test.ts:109:        type: "node.created",
packages/core/test/purgehold.test.ts:29:  ev({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
packages/core/test/records.test.ts:37:    { type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } },
packages/core/test/stop-declared.test.ts:29:      type: "node.created",
packages/core/test/t13e.test.ts:40:  ev({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
packages/core/test/ui-view.test.ts:34:    type: "node.created",
packages/core/test/visible.test.ts:14:  ev({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
packages/daemon/src/api/handlers/spawn-handlers.ts:353:      type: "node.created",
packages/daemon/src/compose.ts:608:        type: "node.created",
packages/daemon/test/api/accepted-session-stop.test.ts:37:      type: "node.created",
packages/daemon/test/api/authorize.test.ts:31:  ev({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
packages/daemon/test/api/child-inbox.test.ts:33:    type: "node.created",
packages/daemon/test/api/child-inbox.test.ts:39:      type: "node.created",
packages/daemon/test/api/cli-bind-server.test.ts:21:      type: "node.created",
packages/daemon/test/api/cli-bind-server.test.ts:26:      type: "node.created",
packages/daemon/test/api/cli-bind-server.test.ts:31:      type: "node.created",
packages/daemon/test/api/confirmation-gate.test.ts:22:      type: "node.created",
packages/daemon/test/api/dedupe-server.test.ts:31:      type: "node.created",
packages/daemon/test/api/dedupe-server.test.ts:36:      type: "node.created",
packages/daemon/test/api/dedupe-server.test.ts:41:      type: "node.created",
packages/daemon/test/api/handlers/answer-delivery.test.ts:48:    type: "node.created",
packages/daemon/test/api/handlers/answer-delivery.test.ts:53:    type: "node.created",
packages/daemon/test/api/handlers/answer-delivery.test.ts:58:    type: "node.created",
packages/daemon/test/api/handlers/bind-handlers.test.ts:32:    add({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
## STATE_VERSION
packages/daemon/src/children-dir.ts:9: *   同じ鍵を計算し直せる（対応を記録に持たないので、STATE_VERSION は変えない）。秘密がないのに、鍵の形の引き出しが残っている
packages/daemon/src/eventlog.ts:84:export const STATE_VERSION = 14;
packages/daemon/src/eventlog.ts:190:  if (snap === undefined || snap.stateVersion !== STATE_VERSION || !Number.isInteger(snap.lastSeq))
packages/daemon/src/eventlog.ts:395:            stateVersion: STATE_VERSION,
packages/daemon/src/eventlog.ts:499:              stateVersion: STATE_VERSION,
packages/daemon/test/eventlog.test.ts:5:import { EventLog, eventHash, STATE_VERSION } from "../src/eventlog.js";
packages/daemon/test/eventlog.test.ts:240:    expect(saved?.stateVersion).toBe(STATE_VERSION);
packages/daemon/test/eventlog.test.ts:258:      stateVersion: over.stateVersion ?? STATE_VERSION,
packages/daemon/test/eventlog.test.ts:286:    saveSnap(shared, 9, stale, { stateVersion: STATE_VERSION + 1 });
packages/daemon/test/eventlog.test.ts:291:    expect(STATE_VERSION).toBe(14);
## parentRequests
packages/core/src/events.ts:650:  readonly parentRequests: readonly ParentRequestRecord[];
packages/core/src/events.ts:736:  parentRequests: [],
packages/core/src/events.ts:831:  parentRequests: ParentRequestRecord[];
packages/core/src/events.ts:1005:  const parentRequests = arrayOf<ParentRequestRecord>(state.parentRequests, parentRequestShape);
packages/core/src/events.ts:1023:    !parentRequests ||
packages/core/src/events.ts:1045:    parentRequests: [...parentRequests],
packages/core/src/events.ts:1100:    parentRequests: Object.freeze(d.parentRequests),
packages/core/src/events.ts:2124:      if (d.parentRequests.some((r) => r.requestRef === requestRef))
packages/core/src/events.ts:2126:      d.parentRequests.push(
packages/core/src/events.ts:2150:      const i = d.parentRequests.findIndex((r) => r.requestRef === requestRef);
packages/core/src/events.ts:2151:      const r = i < 0 ? undefined : d.parentRequests[i];
packages/core/src/events.ts:2162:      d.parentRequests[i] = freezeRecord({
packages/core/src/ui-view.ts:300:    state.parentRequests
packages/core/src/visible.ts:24:      parentRequests: Object.freeze(mine(state.parentRequests)),
packages/daemon/src/api/handlers/parent-request-handlers.ts:88:  [...state.parentRequests]
packages/daemon/src/api/handlers/parent-request-handlers.ts:96:          state.parentRequests.some((x) => x.requestRef === withRefOf(nodeId, r.requestRef))),
packages/daemon/src/api/handlers/parent-request-handlers.ts:119:  if (node?.discarded === undefined || openRequestOf(state.parentRequests, nodeId) !== undefined)
packages/daemon/src/api/handlers/parent-request-handlers.ts:121:  const lastRemove = [...state.parentRequests]
packages/daemon/src/api/handlers/parent-request-handlers.ts:126:  if (state.parentRequests.some((r) => r.requestRef === requestRef)) return [];
packages/daemon/src/api/handlers/parent-request-handlers.ts:154:  const launched = state.parentRequests.some(
packages/daemon/src/api/handlers/parent-request-handlers.ts:157:  if (!launched || openRequestOf(state.parentRequests, nodeId) === undefined) return [];
packages/daemon/src/api/handlers/parent-request-handlers.ts:178:  const launch = [...state.parentRequests]
packages/daemon/src/api/handlers/parent-request-handlers.ts:181:  if (launch === undefined || openRequestOf(state.parentRequests, nodeId) !== undefined) return [];
packages/daemon/src/api/handlers/parent-request-handlers.ts:183:  if (state.parentRequests.some((r) => r.requestRef === requestRef)) return [];
packages/daemon/src/api/handlers/parent-request-handlers.ts:215:      const r = openRequestOf(state.parentRequests, nodeId);
packages/daemon/src/api/handlers/parent-request-handlers.ts:306:      const r = state.parentRequests.find((x) => x.requestRef === requestRef);
packages/daemon/src/api/sse-hub.ts:92:    for (const r of state.parentRequests) {
packages/daemon/src/cli-watch.ts:67:    ...state.parentRequests.filter((x) => x.nodeId === nodeId).map((x) => ms(x.report?.at)),
packages/daemon/src/cli-watch.ts:101:    const launch = [...state.parentRequests]
packages/daemon/src/compose.ts:930:    for (const r of log.state().parentRequests) {
packages/daemon/src/compose.ts:952:        openRequestOf(st0.parentRequests, n.id) === undefined
packages/daemon/src/eventlog.ts:83:/** スナップショットに保存する core の状態のスキーマの版。`OrchState` の形を変えたら上げる（2: 停止の試行・観測の記録を追加、3: 範囲外のツール拒否・予期しない終了・報告の記録と、判断要求の内容を追加、4: 範囲の拡張要求・追加指示の記録と、ノ
packages/daemon/src/sdk/cli-adapter.ts:107:  [...state.parentRequests].reverse().find((r) => r.nodeId === nodeId && r.kind === "launch");
packages/daemon/test/api/accepted-session-stop.test.ts:79:  const open = () => [...log.state().parentRequests].reverse().find((r) => r.report === undefined);
packages/daemon/test/api/accepted-session-stop.test.ts:137:    expect(r.log.state().parentRequests).toHaveLength(0);
packages/daemon/test/api/accepted-session-stop.test.ts:152:    const count = () => r.log.state().parentRequests.filter((x) => x.kind === "stop").length;
packages/daemon/test/api/accepted-session-stop.test.ts:172:    expect(r.log.state().parentRequests.filter((x) => x.kind === "stop")).toHaveLength(1);
packages/daemon/test/api/parent-request.test.ts:109:    expect(st.parentRequests).toHaveLength(1);
packages/daemon/test/api/parent-request.test.ts:110:    expect(st.parentRequests[0]).toMatchObject({
packages/daemon/test/api/parent-request.test.ts:139:    expect(r.log.state().parentRequests).toHaveLength(0);
## @\{upstream\}
packages/daemon/src/git-ports.ts:427:    const up = await git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
packages/daemon/src/git-ports.ts:644:        const up = await git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
packages/daemon/src/git-ports.ts:767:          const up = await git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
packages/daemon/src/git-ports.ts:855:        const up = await git(["rev-parse", "--abbrev-ref", `${branchOf(nodeId)}@{upstream}`]);
packages/daemon/src/git-ports.ts:891:          const up = await git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);

## createGitPorts(
packages/daemon/src/git-ports.ts:265:export function createGitPorts(
packages/daemon/src/loaders.ts:6: * - 口を作る関数が `Result` を返す場合（`createGitPorts`）は、失敗をそのまま（原因つきで）返す。
packages/daemon/src/loaders.ts:73:    typeof m.createGitPorts === "function"
packages/daemon/src/loaders.ts:74:      ? (m.createGitPorts as (c: unknown) => Result<WorktreePorts, Failure>)(config)
packages/daemon/test/child-marker-real-git.test.ts:6:import { CHILD_WORKTREE_MARKER, createGitPorts, nodeGit } from "../src/git-ports.js";
packages/daemon/test/child-marker-real-git.test.ts:33:    const made = createGitPorts(
packages/daemon/test/git-missing.test.ts:6:  createGitPorts,
packages/daemon/test/git-missing.test.ts:104:    const made = createGitPorts(
packages/daemon/test/git-ports.test.ts:14:  createGitPorts,
packages/daemon/test/git-ports.test.ts:91:  const made = createGitPorts(
packages/daemon/test/git-ports.test.ts:139:    const made = createGitPorts({
packages/daemon/test/git-ports.test.ts:220:    const made = createGitPorts({
packages/daemon/test/git-ports.test.ts:230:describe("createGitPorts（実際の git で、作業ツリーの作成・事実・削除を確かめる）", () => {
packages/daemon/test/git-ports.test.ts:494:    const made = createGitPorts({
packages/daemon/test/git-ports.test.ts:850:    const made = createGitPorts(
packages/daemon/test/integrate-real-git.test.ts:14:import { createGitPorts, nodeGit } from "../src/git-ports.js";
packages/daemon/test/integrate-real-git.test.ts:40:  const made = createGitPorts(
packages/daemon/test/reclaim-real-git.test.ts:10:import { createGitPorts, nodeGit } from "../src/git-ports.js";
packages/daemon/test/reclaim-real-git.test.ts:37:  const made = createGitPorts(
packages/daemon/test/startup-real-git.test.ts:265:    // repoRoot をリンク経由にして、createGitPorts を失敗させる
packages/daemon/test/worktree-seed.test.ts:15:import { createGitPorts, nodeGit } from "../src/git-ports.js";
packages/daemon/test/worktree-seed.test.ts:55:  const made = createGitPorts(

## parentSessionId / node.spawn (mcp/src, cli/src)
packages/mcp/src/relay.ts:14:const LONG_OPERATIONS: ReadonlySet<string> = new Set(["node.spawn", "node.split", "node.reclaim"]);
packages/mcp/src/schemas.ts:60:  "node.spawn": withBrief({
packages/mcp/src/schemas.ts:285:        if (operation === "node.spawn" || operation === "node.split" || operation === "node.adopt") {
packages/mcp/src/tools.ts:37:  "node.spawn":
packages/mcp/src/server.ts:37:  readonly parentSessionId?: string;
packages/mcp/src/server.ts:292:        (operation === "node.bindCode" || operation === "node.spawn") &&
packages/mcp/src/server.ts:293:        init.parentSessionId !== undefined
packages/mcp/src/server.ts:294:          ? { ...(parsed.value.forward as object), parentSessionId: init.parentSessionId }
packages/mcp/src/server.ts:358:  parentSessionId?: string,
packages/mcp/src/server.ts:382:        ...(parentSessionId === undefined ? {} : { parentSessionId }),
