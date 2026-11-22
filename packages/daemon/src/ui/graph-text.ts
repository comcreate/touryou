/**
 * 関係図（graph.js）が使う文字の表（#140）。鍵 → { ja, en }。ja は、#140 より前の図・画面の文と同じ。
 * 状態・役割・やり取り・段・時刻の言葉は、画面（app.js）も同じ鍵で使う（i18n.ts の UI_TEXT にまとめる）。
 * graph.js の束には、この表だけを入れる（画面の表は入れない。束を小さく保つ）。
 */
/** 言語（core の `Lang` と同じ。束を小さく保つため、core の知らせの表を import しない）。 */
export type Lang = "ja" | "en";
export const GRAPH_TEXT = {
  "flow.answer": { ja: "答え", en: "answer" },
  "flow.approved": { ja: "許可", en: "approved" },
  "flow.decision": { ja: "判断を求む", en: "decision needed" },
  "flow.done": { ja: "済んだの報告", en: "done report" },
  "flow.extension": { ja: "範囲の頼み", en: "scope request" },
  "flow.instruction": { ja: "指示", en: "instruction" },
  "flow.rejected": { ja: "却下", en: "rejected" },
  "flow.report": { ja: "報告", en: "report" },
  "flow.split": { ja: "切り出し", en: "split off" },
  "flow.sum": { ja: "{dir} {who}　{kind}", en: "{dir} {who}  {kind}" },
  "flow.withText": { ja: "{sum}：{text}", en: "{sum}: {text}" },
  "flow.you": { ja: "あなた", en: "you" },
  "role.below": { ja: "{role}（配下 {n} 件）", en: "{role} ({n} below)" },
  "role.belowHuman": {
    ja: "{role}（配下 {n} 件・あなたの答え {h} 件）",
    en: "{role} ({n} below, {h} awaiting you)",
  },
  "role.implement": { ja: "作業", en: "work" },
  "role.integrator": { ja: "統合", en: "integrator" },
  "role.investigate": { ja: "調べ", en: "investigation" },
  "role.merge": { ja: "まとめ", en: "merge" },
  "role.review": { ja: "レビュー", en: "review" },
  "run.done": { ja: "済んだと報告（確かめ待ち）", en: "reported done (to be checked)" },
  "run.pending": { ja: "起動を待っている", en: "waiting to start" },
  "run.running": { ja: "動いている", en: "running" },
  "run.stopIncomplete": { ja: "■ 止まりきっていない", en: "■ not fully stopped" },
  "run.stopping": { ja: "止めている", en: "stopping" },
  "run.waiting": { ja: "待っている", en: "waiting" },
  "stage.delivered": { ja: "届いた（返事を待っている）", en: "delivered (waiting for a reply)" },
  "stage.done": { ja: "済んだ", en: "done" },
  "stage.doneInferred": { ja: "済んだ（推定）", en: "done (inferred)" },
  "stage.sent": { ja: "送った（まだ届いていない）", en: "sent (not delivered yet)" },
  "stage.sentUnknown": {
    ja: "送った（届いたかは分からない）",
    en: "sent (not known whether it arrived)",
  },
  "stage.withdrawn": { ja: "取り下げた", en: "withdrawn" },
  "status.done": { ja: "済んだ", en: "done" },
  "status.fail": { ja: "✕ 失敗", en: "✕ failed" },
  "status.run": { ja: "動いている", en: "running" },
  "status.stall": { ja: "‖ 止まっているかも", en: "‖ may be stuck" },
  "status.stopped": { ja: "■ 止めた", en: "■ stopped" },
  "status.wait": { ja: "● あなたの答え待ち", en: "● waiting for your answer" },
  "time.at": { ja: "{when}（{ago}）", en: "{when} ({ago})" },
  "time.dayAgo": { ja: "{n} 日前", en: "{n} d ago" },
  "time.hourAgo": { ja: "{n} 時間前", en: "{n} h ago" },
  "time.minAgo": { ja: "{n} 分前", en: "{n} min ago" },
  "time.now": { ja: "いま", en: "just now" },
  "flow.other": { ja: "やり取り", en: "exchange" },
  "graph.boxLabel": { ja: "{title}。{status}", en: "{title}. {status}" },
  "graph.hidden": { ja: "{n} 件隠しています", en: "{n} hidden" },
  "graph.laneAgo": { ja: "{arrow}{label}　{ago}", en: "{arrow}{label}  {ago}" },
  "graph.lineTitle": { ja: "{label}：{stage}", en: "{label}: {stage}" },
  "graph.roleAgo": { ja: "{role}　{ago}", en: "{role} · {ago}" },
} as const satisfies Readonly<Record<string, { readonly ja: string; readonly en: string }>>;

export type GraphTextKey = keyof typeof GRAPH_TEXT;

/** 図の言葉（`{名前}` を値で置き換える）。 */
export const graphString = (
  lang: Lang,
  key: GraphTextKey,
  args: Readonly<Record<string, string | number>> = {},
): string =>
  GRAPH_TEXT[key][lang].replace(/\{([a-z][A-Za-z0-9]*)\}/g, (all, name: string) =>
    Object.hasOwn(args, name) ? String(args[name]) : all,
  );
