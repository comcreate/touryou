/**
 * 関係図に渡す値の作り直し（#89。純粋な関数）。表示モデル（形を信じない）から、整えた文字・確かめた ID・数だけを作る。
 */
import { ID_PATTERN } from "../../../core/src/ids.js";
import { UI_HUMAN, uiText } from "../../../core/src/ui-view.js";
import type { Dir } from "./graph-path.js";

export const STAGES = ["sent", "delivered", "done"] as const;
export type Stage = (typeof STAGES)[number];
const ROLE_NAMES: Readonly<Record<string, string>> = {
  integrator: "統合",
  implement: "実装",
  review: "レビュー",
  investigate: "調査",
  merge: "マージ",
};
const BANDS = ["turn", "running", "finished"] as const;
type Band = (typeof BANDS)[number];
const KIND_NAMES: Readonly<Record<string, string>> = {
  instruction: "指示",
  report: "報告",
  done: "完了",
  decision: "判断",
  extension: "範囲の頼み",
  answer: "答え",
  parentRequest: "親への頼み",
};

export interface GraphNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly title: string;
  readonly sub: string;
  readonly band: Band;
}
/** 人（ノードでない相手）。木の外に 1 つの箱として置く。 */
export const HUMAN = UI_HUMAN;

export interface GraphLane {
  /** 親のノード ID。人とのやり取りなら `HUMAN`（`human` が true）。 */
  readonly parent: string;
  readonly child: string;
  readonly dir: Dir;
  readonly stage: Stage;
  readonly unknown: boolean;
  readonly label: string;
  /** 人とのやり取り（段を飛ばす。木の外の「人」の箱から、通り道を通して描く）。 */
  readonly human: boolean;
  /** 人の答えを待っている（判断・範囲の頼みが、まだ済んでいない）。柿色で描く。 */
  readonly waiting: boolean;
}
export interface GraphModel {
  readonly nodes: readonly GraphNode[];
  readonly lanes: readonly GraphLane[];
}

const own = (o: object, k: string): boolean => Object.hasOwn(o, k);
const idOf = (x: unknown): string | null =>
  typeof x === "string" && ID_PATTERN.test(x) ? x : null;
const rec = (x: unknown): Record<string, unknown> | null =>
  typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
const list = (x: unknown, max: number): readonly unknown[] =>
  Array.isArray(x) ? x.slice(0, max) : [];

/** 表示モデル（形を信じない）から、描く値だけを作り直す。 */
export function graphModelOf(view: unknown): GraphModel {
  const v = rec(view) ?? {};
  const nodes: GraphNode[] = [];
  const known = new Set<string>();
  for (const x of list(v.nodes, 500)) {
    const n = rec(x);
    const id = idOf(n?.id);
    if (n === null || id === null || known.has(id)) continue;
    known.add(id);
    const role =
      typeof n.role === "string" && own(ROLE_NAMES, n.role)
        ? (ROLE_NAMES[n.role] as string)
        : "作業";
    const band: Band = BANDS.find((b) => b === n.band) ?? "running";
    const state = uiText(n.state, 40);
    nodes.push({
      id,
      parentId: idOf(n.parentId),
      title: n.title === undefined ? id : uiText(n.title, 80),
      sub: uiText(`${role}・${state}`, 60),
      band,
    });
  }
  const lanes: GraphLane[] = [];
  const parentOf = new Map(nodes.map((n) => [n.id, n.parentId]));
  const taken = new Set<string>();
  // flows は新しい順。親子の枝ごと・向きごとに、いちばん新しいものだけ
  for (const x of list(v.flows, 200)) {
    const f = rec(x);
    if (f === null) continue;
    const from = f.from === HUMAN ? HUMAN : idOf(f.from);
    const to = f.to === HUMAN ? HUMAN : idOf(f.to);
    const dir = f.dir === "up" || f.dir === "down" ? f.dir : null;
    const stage = STAGES.find((s) => s === f.stage);
    if (from === null || to === null || dir === null || stage === undefined) continue;
    const [parent, child] = dir === "up" ? [to, from] : [from, to];
    const human = parent === HUMAN;
    if (child === HUMAN || !known.has(child)) continue;
    // 人とのやり取りは、根でも孫でも描く（段を飛ばす）。ノードどうしは、親子の枝だけ
    if (!human && parentOf.get(child) !== parent) continue;
    const key = `${parent} ${child} ${dir}`;
    if (taken.has(key)) continue;
    taken.add(key);
    const kind =
      typeof f.kind === "string" && own(KIND_NAMES, f.kind)
        ? (KIND_NAMES[f.kind] as string)
        : "やり取り";
    const asks = f.kind === "decision" || f.kind === "extension";
    lanes.push({
      parent,
      child,
      dir,
      stage,
      unknown: f.deliveryUnknown === true,
      label: kind,
      human,
      waiting: human && asks && dir === "up" && stage !== "done",
    });
  }
  return { nodes, lanes };
}

export const STAGE_TEXT: Readonly<Record<string, string>> = {
  sent: "送った・まだ届いていない",
  unknown: "届いたか分からない",
  delivered: "届いた・返事待ち",
  done: "済んだ",
};
