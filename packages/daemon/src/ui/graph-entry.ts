/**
 * 関係図の入口（#89。設計の下書き 4.2・6・7 節）。
 * 外に出すのは `window.touryouGraph` の `draw(host, view)`・`destroy()` だけ。`draw` は、表示モデルから「整えた文字・確かめた ID・数」だけを作り直して描く。
 * 表示モデルをそのまま rete に渡さない。rete のノード・つながりのデータは、ID と数だけ。
 * 描画のプラグインは使わず、area のプラグインの `render` の合図を受けて、箱は `el`、線は `svgEl` で自前に描く（R0）。
 */
import { type GetSchemes, NodeEditor } from "rete";
import { AreaExtensions, AreaPlugin } from "rete-area-plugin";
import { ReadonlyPlugin } from "rete-readonly-plugin";
import { BOX_W, COL_GAP, type LayoutPos, layoutOf } from "./graph-layout.js";
import { type GraphLane, type GraphNode, graphModelOf, STAGE_TEXT } from "./graph-model.js";
import {
  bendXOf,
  humanColumnOf,
  humanLaneOf,
  type Lane,
  laneOf,
  setRunnerPath,
  twigOf,
} from "./graph-path.js";
import { svgEl } from "./svg-el.js";

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

/** 「人」の箱の rete の ID。ノードの ID（`ID_PATTERN`。空白を含まない）と重ならない。 */
const HUMAN_NODE = " human";

let current: AreaPlugin<Schemes, never> | null = null;

/** いまの図を消す（描いていなければ何もしない）。 */
export function destroy(): void {
  current?.destroy();
  current = null;
}

/** 図を描く。前の図は消してから描く。 */
export async function draw(host: HTMLElement, view: unknown): Promise<void> {
  destroy();
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
        const s = laneShape(l, laneOf(P, C, bx, l.dir), byId.get(kid)?.band === "finished");
        conns.push({
          id: `c${conns.length}`,
          source: l.dir === "up" ? kid : pid,
          target: l.dir === "up" ? pid : kid,
          shape: shapes.length,
        });
        shapes.push(s);
      }
    });
  }
  // 人とのやり取り（段を飛ばす）：木の右に縦の通り道をとり、その右に「人」の箱を置く
  const humanLanes = model.lanes.filter((l) => l.human && L.pos.has(l.child));
  const talkers = [...new Set(humanLanes.map((l) => l.child))];
  let width = L.width;
  let height = L.height;
  let H: LayoutPos | null = null;
  if (humanLanes.length > 0) {
    const col = humanColumnOf(L, talkers.length);
    H = col.human;
    width = col.width;
    height = col.height;
    for (const l of humanLanes) {
      const N = L.pos.get(l.child) as LayoutPos;
      const lane = humanLaneOf(N, H, col.corridorX(talkers.indexOf(l.child)), l.dir);
      conns.push({
        id: `c${conns.length}`,
        source: l.dir === "up" ? l.child : HUMAN_NODE,
        target: l.dir === "up" ? HUMAN_NODE : l.child,
        shape: shapes.length,
      });
      shapes.push(laneShape(l, lane, byId.get(l.child)?.band === "finished"));
    }
  }

  const editor = new NodeEditor<Schemes>();
  const area = new AreaPlugin<Schemes, never>(host);
  current = area;
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
    if (type === "node") {
      if (payload.id === HUMAN_NODE) drawHuman(element);
      else drawNode(element, byId.get(payload.id));
    } else if (type === "connection")
      drawShape(element, shapes[(payload as ReteConn).shape], width, height);
    return ctx;
  });

  for (const n of model.nodes) await editor.addNode({ id: n.id });
  if (H !== null) await editor.addNode({ id: HUMAN_NODE });
  for (const c of conns) await editor.addConnection(c);
  for (const n of model.nodes) {
    const p = L.pos.get(n.id);
    if (p !== undefined) await area.translate(n.id, { x: p.x, y: p.y });
  }
  if (H !== null) await area.translate(HUMAN_NODE, { x: H.x, y: H.y });
  readonly.enable(); // 置いたあとは、つなぐ・動かす・消すを止める（拡大・移動は残る）
  await AreaExtensions.zoomAt(area, editor.getNodes());
}

/** 線 1 本の形と見え方。終わった作業の線は止める。人の答えを待つものだけ柿色（`wait`）。 */
function laneShape(l: GraphLane, lane: Lane, finished: boolean): Shape {
  const stage = finished ? "done" : l.stage === "sent" && l.unknown ? "unknown" : l.stage;
  const extra = `${l.human ? " human" : ""}${l.waiting && !finished ? " wait" : ""}`;
  return {
    kind: "lane",
    d: lane.d,
    tip: lane.tip,
    look: `${l.dir}${extra} g-${stage}`,
    label: `${l.dir === "up" ? "← " : "→ "}${l.label}`,
    note: `${l.label}：${STAGE_TEXT[stage] ?? ""}`,
    labelX: lane.labelX,
    labelY: lane.labelY,
  };
}

function drawHuman(element: HTMLElement): void {
  element.replaceChildren();
  const box = el("div", "gnode b-human");
  box.dataset.id = "human";
  box.append(el("span", "gt", "人（あなた）"), el("span", "gs", "答える・決める"));
  element.append(box);
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
