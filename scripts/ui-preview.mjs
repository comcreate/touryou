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
const LIVE_MS = Number(process.env.TOURYOU_PREVIEW_LIVE_MS ?? "3000");

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

// --- 種（起動のときの今を基準にした時刻）---
const NOW = Date.now();
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const XSS = '<script>alert("xss")</script><img src=x onerror="alert(1)">';
const HUMAN = { human: true };
const by = (nodeId) => ({ nodeId });

let seq = 0;
const next = () => ++seq;
const node = (id, role, parentId, state, objective, extra = {}) => ({
  id,
  role,
  parentId,
  dependsOn: [],
  state,
  objective,
  ...extra,
});

const nodes = [
  node("root", "integrator", null, "running", "v0.1.4 の公開に向けた統合"),
  node(
    "c1",
    "implement",
    "root",
    "running",
    "状態画面の関係図を、見本の v8 の形にそろえ、箱・線・札・凡例の描き方を整え、狭い窓でも崩れないようにする（長い題の見え方の確かめ）",
  ),
  node("c2", "investigate", "root", "waiting", "調べ: SSE の枠"),
  node("c3", "implement", "root", "running", "CLI の子の探すコマンド"),
  node("c4", "review", "root", "running", "レビュー"),
  node("c5", "implement", "root", "running", "配布物の確かめを直す"),
  node("g1", "implement", "c1", "done", "線の札の時刻"),
  node("g2", "implement", "c1", "verified", "凡例", { reviewedSeq: 0, reviewedAt: ago(20) }),
  node("g3", "investigate", "c3", "stopped", "古い調べ（止めた）"),
  node("g4", "implement", "c5", "archived", "片付け済みの作業", { archivedAt: ago(120) }),
];

const instructions = [];
const reports = [];
const inbox = [];
const decisions = [];
const extensions = [];

const instruct = (nodeId, actor, at, deliveredAt, text = "追加の指示") => {
  const s = next();
  const rec = { seq: s, at, nodeId, text, actor };
  if (deliveredAt !== undefined) Object.assign(rec, { deliveredSeq: next(), deliveredAt });
  instructions.push(rec);
  return rec;
};
const report = (nodeId, kind, at, text = "報告") => {
  const s = next();
  reports.push({ seq: s, at, reportId: `rep-${s}`, nodeId, kind, text, actor: by(nodeId) });
  return s;
};
const item = (nodeId, kind, at, summary) => {
  const s = next();
  inbox.push({ seq: s, id: `in-${s}`, kind, nodeId, dependsOn: [], at, summary });
};

// 古いもの（1 時間より前）から新しいもの（5 分以内）へ
instruct("c1", by("root"), ago(95), ago(94), "関係図を見本にそろえる");
report("c1", "progress", ago(90));
item("c1", "progress", ago(90), `箱の形を直しています ${XSS}`);
instruct("c3", by("root"), ago(80), ago(79));
report("c3", "progress", ago(70));
instruct("g3", by("c3"), ago(75), ago(74));
report("g3", "progress", ago(72));
instruct("g4", by("c5"), ago(130), ago(129));
report("g4", "done", ago(125));
// 人の答えた判断（下りの答え）と、却下を含む判断
const dAnsweredReq = next();
const dAnswered = next();
decisions.push({
  decisionId: "d-old",
  nodeId: "c2",
  status: "answered",
  requestedSeq: dAnsweredReq,
  requestedAt: ago(65),
  answeredSeq: dAnswered,
  answeredAt: ago(60),
  question: "どちらの枠の数にしますか",
  options: ["4 本", "8 本"],
  answer: "4 本",
  answeredBy: HUMAN,
  rejected: [{ seq: next(), answer: "16 本", actor: HUMAN }],
});
report("c2", "progress", ago(55));
// 却下した範囲の頼み
const xRejReq = next();
extensions.push({
  extensionId: "x-old",
  nodeId: "c3",
  target: { kind: "command", value: "rm -rf build" },
  reason: "古い成果物を消したい",
  status: "rejected",
  requestedSeq: xRejReq,
  requestedAt: ago(50),
  decidedAt: ago(48),
  decidedSeq: next(),
  decidedBy: HUMAN,
});
instruct("c4", by("root"), ago(45), ago(44), "PR を見る");
instruct("g1", by("c1"), ago(40), ago(39));
report("g1", "progress", ago(35));
instruct("g2", by("c1"), ago(38), ago(37));
const g2done = report("g2", "done", ago(25));
nodes.find((n) => n.id === "g2").reviewedSeq = next();
void g2done;
instruct("c5", HUMAN, ago(30), ago(29), "人からの指示");
report("c5", "failure", ago(15), "試験が落ちた");
item("c5", "failure", ago(15), `試験が落ちました: ${XSS}`);
item("c4", "info", ago(12), core.stallSummary("c4", 30));
report("g1", "done", ago(8));
item("g1", "done", ago(8), "線の札の時刻を足しました");
// 答え待ち（判断の頼み・範囲の頼み）
decisions.push({
  decisionId: "d-open",
  nodeId: "c2",
  status: "open",
  requestedSeq: next(),
  requestedAt: ago(4),
  question: `枠が埋まったとき、どのタブを譲らせますか ${XSS}`,
  options: ["いちばん古いタブ", "裏に回ったタブ"],
  rejected: [],
});
extensions.push({
  extensionId: "x-open",
  nodeId: "c3",
  target: { kind: "write", value: "docs/ui.md" },
  reason: `文書も直したい ${XSS}`,
  status: "open",
  requestedSeq: next(),
  requestedAt: ago(2),
});
instruct("c1", by("root"), ago(3), ago(2), "凡例も見本にそろえる");
instruct("c4", HUMAN, ago(1), undefined, "人からの短い指示（まだ届いていない）");

let state = {
  ...core.initialState(),
  nodes,
  instructions,
  reports,
  inbox,
  decisions,
  extensions,
  lastSeq: seq,
};

// --- --live: 作り物のやり取りを足し、段を進める ---
const LIVE_TARGETS = ["c1", "c3", "c4", "c5", "g1"];
let liveStep = 0;
let pending; // { nodeId, stage }
const tick = () => {
  const at = new Date().toISOString();
  if (pending === undefined) {
    const nodeId = LIVE_TARGETS[liveStep++ % LIVE_TARGETS.length];
    const parentId = nodes.find((n) => n.id === nodeId)?.parentId ?? "root";
    const s = next();
    state = {
      ...state,
      instructions: [
        ...state.instructions,
        { seq: s, at, nodeId, text: "作り物の指示", actor: by(parentId) },
      ],
      lastSeq: seq,
    };
    pending = { seq: s, nodeId, stage: "sent" };
  } else if (pending.stage === "sent") {
    const d = next();
    state = {
      ...state,
      instructions: state.instructions.map((i) =>
        i.seq === pending.seq ? { ...i, deliveredSeq: d, deliveredAt: at } : i,
      ),
      lastSeq: seq,
    };
    pending = { ...pending, stage: "delivered" };
  } else {
    const s = next();
    state = {
      ...state,
      reports: [
        ...state.reports,
        {
          seq: s,
          at,
          reportId: `rep-${s}`,
          nodeId: pending.nodeId,
          kind: "progress",
          text: "作り物の報告",
          actor: by(pending.nodeId),
        },
      ],
      lastSeq: seq,
    };
    pending = undefined;
  }
};

// --- 立てる ---
const stateDir = mkdtempSync(join(tmpdir(), "touryou-ui-preview-"));
const token = randomBytes(32).toString("base64url");
const server = api.createApiServer({
  credentials: creds.createCredentialStore({ humanToken: token }),
  getState: () => state,
  handlers: {},
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
