/**
 * 関係図の入口（#89。設計の下書き 4.2・6・7 節。見た目は mock.html の `drawNode`・`drawGraph`）。
 * 外に出すのは `window.touryouGraph` の `draw(host, view)`・`destroy()` だけ。`draw` は、表示モデルから「整えた文字・確かめた ID・数」だけを作り直して描く。
 * 表示モデルをそのまま rete に渡さない。rete のノード・つながりのデータは、ID と数だけ。
 * 描画のプラグインは使わず、area のプラグインの `render` の合図を受けて、箱は `el`、線は `svgEl` で自前に描く（R0）。
 */
import { type GetSchemes, NodeEditor } from "rete";
import { AreaPlugin } from "rete-area-plugin";
import { ReadonlyPlugin } from "rete-readonly-plugin";
import { BOX_W, COL_GAP, type LayoutPos, layoutOf, MARGIN } from "./graph-layout.js";
import { agoText, type GraphLane, type GraphNode, graphModelOf, stageText } from "./graph-model.js";
import {
  humanColumnOf,
  humanLaneOf,
  type Lane,
  laneOf,
  roleIconOf,
  setRunnerPath,
  trunkOf,
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
  readonly lane?: Lane;
  readonly look?: string;
  /** 札（種類と「何分前」）と、その外側の段の言葉。 */
  readonly label?: string;
  readonly stage?: string;
}

/** 「人」の箱の rete の ID。ノードの ID（`ID_PATTERN`。空白を含まない）と重ならない。 */
const HUMAN_NODE = " human";
/** 列の見出し（見本の `colhead`）。 */
const COLUMN_NAMES = ["いちばん上の統合", "子", "孫", "ひ孫"];

let current: AreaPlugin<Schemes, never> | null = null;
let currentHost: HTMLElement | null = null;
/** 描きの番号（世代）。`draw`・`destroy` のたびに進む。古い `draw` の続きは、番号が違えば黙って抜ける。 */
let generation = 0;

/** いまの図を消す（描いていなければ何もしない）。描いている途中の `draw` も、そこで止まる。 */
export function destroy(): void {
  generation += 1;
  current?.destroy();
  current = null;
  currentHost?.replaceChildren(); // area の器も片付ける
  currentHost = null;
}

/** 描いた図の、画面での大きさ（拡大のあと。枠の高さを中身に合わせるのに使う）。 */
export interface Drawn {
  readonly width: number;
  readonly height: number;
}

/**
 * 図を描く。前の図（描いている途中のものも）は消してから描く。
 * 途中で次の `draw` か `destroy` が呼ばれたら、例外を出さずに抜ける（取り残さない。そのときは大きさ 0 を返す）。
 * 枠の幅に合わせて縮める（大きくはしない）。拡大・移動は、そのあとも人が変えられる。
 */
export async function draw(host: HTMLElement, view: unknown): Promise<Drawn> {
  destroy();
  const mine = generation;
  const live = (): boolean => mine === generation;
  const none: Drawn = { width: 0, height: 0 };
  const now = Date.now();
  const model = graphModelOf(view);
  const L = layoutOf(model.nodes);
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const shapes: Shape[] = [];
  const conns: ReteConn[] = [];
  const trunks: string[] = [];
  const add = (s: Shape, source: string, target: string): void => {
    conns.push({ id: `c${conns.length}`, source, target, shape: shapes.length });
    shapes.push(s);
  };
  for (const [pid, kids] of L.children) {
    const P = L.pos.get(pid) as LayoutPos;
    const kidPos = kids.map((k) => L.pos.get(k) as LayoutPos);
    if (kids.length > 0) trunks.push(...trunkOf(P, kidPos));
    kids.forEach((kid, i) => {
      const C = kidPos[i] as LayoutPos;
      const mine = model.lanes.filter((l) => !l.human && l.parent === pid && l.child === kid);
      if (mine.length === 0) add({ kind: "twig", d: twigOf(P, C) }, pid, kid);
      for (const l of mine) {
        const s = laneShape(l, laneOf(P, C, l.dir), byId.get(kid), now);
        add(s, l.dir === "up" ? kid : pid, l.dir === "up" ? pid : kid);
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
      const slot = talkers.indexOf(l.child);
      const lane = humanLaneOf(N, H, col.corridorX(slot), l.dir, slot, talkers.length);
      const s = laneShape(l, lane, byId.get(l.child), now);
      add(s, l.dir === "up" ? l.child : HUMAN_NODE, l.dir === "up" ? HUMAN_NODE : l.child);
    }
  }
  const depths = [...L.pos.values()].reduce((m, p) => Math.max(m, p.depth), 0);

  const editor = new NodeEditor<Schemes>();
  const area = new AreaPlugin<Schemes, never>(host);
  current = area;
  currentHost = host;
  const readonly = new ReadonlyPlugin<Schemes>();
  editor.use(readonly.root);
  editor.use(area);
  area.use(readonly.area);
  // 背景：列の見出しと、親の幹（どのノード・つながりにも属さないので、area の中身にじかに置く）
  area.area.content.add(drawBackdrop(trunks, depths, width, height));

  area.addPipe((ctx) => {
    if (ctx.type !== "render") return ctx;
    const { element, type, payload } = ctx.data as {
      element: HTMLElement;
      type: string;
      payload: { id: string };
    };
    if (type === "node") {
      if (payload.id === HUMAN_NODE) drawHuman(element);
      else drawNode(element, byId.get(payload.id), now);
    } else if (type === "connection")
      drawShape(element, shapes[(payload as ReteConn).shape], width, height);
    return ctx;
  });

  for (const n of model.nodes) {
    await editor.addNode({ id: n.id });
    if (!live()) return none;
  }
  if (H !== null) await editor.addNode({ id: HUMAN_NODE });
  for (const c of conns) {
    if (!live()) return none;
    await editor.addConnection(c);
  }
  for (const n of model.nodes) {
    const p = L.pos.get(n.id);
    if (!live()) return none;
    if (p !== undefined) await area.translate(n.id, { x: p.x, y: p.y });
  }
  if (!live()) return none;
  if (H !== null) await area.translate(HUMAN_NODE, { x: H.x, y: H.y });
  if (!live()) return none;
  readonly.enable(); // 置いたあとは、つなぐ・動かす・消すを止める（拡大・移動は残る）
  // 枠の幅に合わせて縮める（読める大きさを保つため、大きくはしない。小さすぎる木は 0.5 倍まで）
  const k = Math.max(0.5, Math.min(1, host.clientWidth / width));
  await area.area.zoom(k, 0, 0);
  if (!live()) return none;
  await area.area.translate(0, 0);
  return { width: width * k, height: height * k };
}

/** 線 1 本の形と見え方。終わった作業の線は止める。人の答えを待つものだけ柿色（`wait`）。 */
function laneShape(l: GraphLane, lane: Lane, child: GraphNode | undefined, now: number): Shape {
  const finished = child?.tier === "over";
  const stage = finished ? "done" : l.stage === "sent" && l.unknown ? "unknown" : l.stage;
  const extra = `${l.human ? " human" : ""}${l.waiting && !finished ? " wait" : ""}${finished ? " over" : ""}`;
  return {
    kind: "lane",
    d: lane.d,
    lane,
    look: `${l.dir}${extra} g-${stage}`,
    label: `${l.dir === "up" ? "← " : "→ "}${l.label}${l.at === null ? "" : `　${agoText(now - l.at)}`}${l.human ? `　${stageText(l)}` : ""}`,
    stage: l.human ? "" : stageText(l),
  };
}

function drawBackdrop(
  trunks: readonly string[],
  depths: number,
  w: number,
  h: number,
): HTMLElement {
  const box = el("div", "gback");
  const svg = svgEl("svg", { class: "glink", width: w, height: h, viewBox: `0 0 ${w} ${h}` });
  for (let d = 0; d <= depths; d++)
    svg.append(
      svgEl(
        "text",
        { class: "colhead", x: MARGIN + d * (BOX_W + COL_GAP) + 4, y: MARGIN - 18 },
        COLUMN_NAMES[Math.min(d, COLUMN_NAMES.length - 1)] as string,
      ),
    );
  for (const d of trunks) svg.append(svgEl("path", { class: "trunk", d }));
  box.append(svg);
  return box;
}

function drawHuman(element: HTMLElement): void {
  element.replaceChildren();
  const box = el("div", "gnode b-human t-go");
  box.dataset.id = "human";
  box.append(el("span", "gt", "人（あなた）"), el("span", "gs", "答える・決める"));
  element.append(box);
}

/** 箱（見本の `drawNode`）：題・役割の印と「何分前」・状態の言葉と印・動いている点・人の答えの数。 */
function drawNode(element: HTMLElement, n: GraphNode | undefined, now: number): void {
  if (n === undefined) return;
  element.replaceChildren();
  const box = el("div", `gnode t-${n.tier} s-${n.status}`);
  box.dataset.id = n.id;
  const row = el("div", "gr");
  const icon = svgEl("svg", { class: "gic", width: 12, height: 12, viewBox: "0 0 12 12" });
  icon.append(svgEl("path", { class: "role-ic", d: roleIconOf(n.integrator) }));
  row.append(
    icon,
    el("span", "gs", `${n.role}${n.lastAt === null ? "" : `　${agoText(now - n.lastAt)}`}`),
  );
  box.append(el("span", "gt", n.title), row, el("span", `gst st-${n.status}`, n.statusText));
  if (n.alive) box.append(el("span", "galive"));
  if (n.needsHuman > 0) {
    const b = el("span", "gbadge", String(n.needsHuman));
    box.append(b);
  }
  element.append(box);
}

function drawShape(element: HTMLElement, s: Shape | undefined, w: number, h: number): void {
  if (s === undefined) return;
  element.replaceChildren();
  const svg = svgEl("svg", { class: "glink", width: w, height: h, viewBox: `0 0 ${w} ${h}` });
  if (s.kind === "twig") svg.append(svgEl("path", { class: "twig", d: s.d }));
  else if (s.lane !== undefined) {
    const lane = s.lane;
    const look = s.look ?? "";
    const line = svgEl("path", { class: `line ${look}`, d: s.d });
    line.append(svgEl("title", {}, `${s.label ?? ""}：${s.stage ?? ""}`));
    svg.append(line, svgEl("path", { class: `tip ${look}`, d: lane.tip }));
    if (lane.portX !== undefined && lane.portY !== undefined)
      svg.append(
        svgEl("rect", {
          class: `port ${look}`,
          x: lane.portX - 3.5,
          y: lane.portY - 3.5,
          width: 7,
          height: 7,
          rx: 3.5,
        }),
      );
    svg.append(
      svgEl("text", { class: `mlabel ${look}`, x: lane.labelX, y: lane.labelY }, s.label ?? ""),
      svgEl("text", { class: `mstage ${look}`, x: lane.labelX, y: lane.stageY }, s.stage ?? ""),
    );
  }
  element.append(svg);
  if (s.kind === "lane" && (s.look ?? "").endsWith("g-sent")) {
    const dot = el("span", "pip");
    setRunnerPath(dot, s.d);
    element.append(dot);
  }
}
