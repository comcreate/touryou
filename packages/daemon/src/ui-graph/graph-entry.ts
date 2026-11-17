/**
 * 関係図の入口（#89。設計の下書き 4.2・6 節。試作）。
 * `drawGraph(host, view)` は、表示モデルから「整えた文字・確かめた ID・数」だけを作り直して描く。
 * 表示モデルをそのまま rete に渡さない。rete のノード・つながりのデータは、ID と数だけ。
 * 描画のプラグインは使わず、area のプラグインの `render` の合図を受けて、箱は `el`、線は `svgEl` で自前に描く（R0）。
 */
import { type GetSchemes, NodeEditor } from "rete";
import { AreaExtensions, AreaPlugin } from "rete-area-plugin";
import { ReadonlyPlugin } from "rete-readonly-plugin";
import { ID_PATTERN } from "../../../core/src/ids.js";
import { uiText } from "../../../core/src/ui-view.js";
import { BOX_H, BOX_W, COL_GAP, type LayoutPos, layoutOf } from "./graph-layout.js";
import { bendXOf, type Dir, laneOf, setRunnerPath, twigOf } from "./graph-path.js";
import { svgEl } from "./svg-el.js";

// ---- 入口の値の作り直し（純粋） ----

export const STAGES = ["sent", "delivered", "done"] as const;
export type Stage = (typeof STAGES)[number];
const ROLE_NAMES: Readonly<Record<string, string>> = {
  integrator: "統合",
  implement: "実装",
  review: "レビュー",
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
export interface GraphLane {
  readonly parent: string;
  readonly child: string;
  readonly dir: Dir;
  readonly stage: Stage;
  readonly unknown: boolean;
  readonly label: string;
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
    const from = idOf(f.from);
    const to = idOf(f.to);
    const dir = f.dir === "up" || f.dir === "down" ? f.dir : null;
    const stage = STAGES.find((s) => s === f.stage);
    if (from === null || to === null || dir === null || stage === undefined) continue;
    const [parent, child] = dir === "up" ? [to, from] : [from, to];
    if (parentOf.get(child) !== parent) continue; // 段を飛ばすやり取りは、この試作では描かない
    const key = `${parent} ${child} ${dir}`;
    if (taken.has(key)) continue;
    taken.add(key);
    const kind =
      typeof f.kind === "string" && own(KIND_NAMES, f.kind)
        ? (KIND_NAMES[f.kind] as string)
        : "やり取り";
    lanes.push({ parent, child, dir, stage, unknown: f.deliveryUnknown === true, label: kind });
  }
  return { nodes, lanes };
}

const STAGE_TEXT: Readonly<Record<string, string>> = {
  sent: "送った・まだ届いていない",
  unknown: "届いたか分からない",
  delivered: "届いた・返事待ち",
  done: "済んだ",
};

// ---- 描き手 ----

const TAGS: Readonly<Record<string, true>> = { div: true, span: true };
function el(tag: string, cls: string, text?: string): HTMLElement {
  if (!Object.hasOwn(TAGS, tag)) throw new Error("el: tag");
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** rete に渡すのは、ID と数だけ。 */
interface ReteNode {
  id: string;
}
interface ReteConn {
  id: string;
  source: string;
  target: string;
  /** 描く線の番号（`shapes` の添え字）。 */
  shape: number;
}
type Schemes = GetSchemes<ReteNode, ReteConn>;

interface Shape {
  readonly kind: "twig" | "lane";
  readonly d: string;
  readonly tip?: string;
  readonly look?: string;
  readonly label?: string;
  /** 線に指を置いたときの説明（段の言葉）。 */
  readonly note?: string;
  readonly labelX?: number;
  readonly labelY?: number;
}

export interface GraphHandle {
  destroy(): void;
}

export async function drawGraph(host: HTMLElement, view: unknown): Promise<GraphHandle> {
  const model = graphModelOf(view);
  const L = layoutOf(model.nodes);
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const shapes: Shape[] = [];
  const conns: ReteConn[] = [];
  for (const [pid, kids] of L.children) {
    const P = L.pos.get(pid) as LayoutPos;
    const kidPos = kids.map((k) => L.pos.get(k) as LayoutPos);
    const bends = bendXOf(P, kidPos, COL_GAP);
    kids.forEach((kid, i) => {
      const C = kidPos[i] as LayoutPos;
      const bx = bends[i] as number;
      const mine = model.lanes.filter((l) => l.parent === pid && l.child === kid);
      const add = (s: Shape, source: string, target: string): void => {
        conns.push({ id: `c${conns.length}`, source, target, shape: shapes.length });
        shapes.push(s);
      };
      if (mine.length === 0) add({ kind: "twig", d: twigOf(P, C, bx) }, pid, kid);
      for (const l of mine) {
        const lane = laneOf(P, C, bx, l.dir);
        const look = l.stage === "sent" && l.unknown ? "unknown" : l.stage;
        const still = byId.get(kid)?.band === "finished";
        add(
          {
            kind: "lane",
            d: lane.d,
            tip: lane.tip,
            look: `${l.dir} g-${still ? "done" : look}`,
            label: `${l.dir === "up" ? "← " : "→ "}${l.label}`,
            note: `${l.label}：${STAGE_TEXT[still ? "done" : look] ?? ""}`,
            labelX: lane.labelX,
            labelY: lane.labelY,
          },
          l.dir === "up" ? kid : pid,
          l.dir === "up" ? pid : kid,
        );
      }
    });
  }

  const editor = new NodeEditor<Schemes>();
  const area = new AreaPlugin<Schemes, never>(host);
  const readonly = new ReadonlyPlugin<Schemes>();
  editor.use(readonly.root);
  editor.use(area);
  area.use(readonly.area);

  area.addPipe((ctx) => {
    if (ctx.type !== "render") return ctx;
    const { element, type, payload } = ctx.data as {
      element: HTMLElement;
      type: string;
      payload: { id: string };
    };
    if (type === "node") drawNode(element, byId.get(payload.id));
    else if (type === "connection")
      drawShape(element, shapes[(payload as ReteConn).shape], L.width, L.height);
    return ctx;
  });

  for (const n of model.nodes) await editor.addNode({ id: n.id });
  for (const c of conns) await editor.addConnection(c);
  for (const n of model.nodes) {
    const p = L.pos.get(n.id);
    if (p !== undefined) await area.translate(n.id, { x: p.x, y: p.y });
  }
  readonly.enable(); // 置いたあとは、つなぐ・動かす・消すを止める（拡大・移動は残る）
  await AreaExtensions.zoomAt(area, editor.getNodes());
  return { destroy: () => area.destroy() };
}

function drawNode(element: HTMLElement, n: GraphNode | undefined): void {
  if (n === undefined) return;
  element.replaceChildren();
  const box = el("div", `gnode b-${n.band}`);
  box.dataset.id = n.id;
  box.append(el("span", "gt", n.title), el("span", "gs", n.sub));
  element.append(box);
}

function drawShape(element: HTMLElement, s: Shape | undefined, w: number, h: number): void {
  if (s === undefined) return;
  element.replaceChildren();
  const svg = svgEl("svg", { class: "glink", width: w, height: h, viewBox: `0 0 ${w} ${h}` });
  if (s.kind === "twig") svg.append(svgEl("path", { class: "twig", d: s.d }));
  else {
    const line = svgEl("path", { class: `line ${s.look ?? ""}`, d: s.d });
    line.append(svgEl("title", {}, s.note ?? ""));
    svg.append(line, svgEl("path", { class: `tip ${s.look ?? ""}`, d: s.tip ?? "" }));
    svg.append(
      svgEl("text", { class: "mlabel", x: s.labelX ?? 0, y: s.labelY ?? 0 }, s.label ?? ""),
    );
  }
  element.append(svg);
  if (s.kind === "lane" && (s.look ?? "").endsWith("g-sent")) {
    const dot = el("span", "pip");
    setRunnerPath(dot, s.d);
    element.append(dot);
  }
}

export { BOX_H, BOX_W };
