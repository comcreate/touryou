/**
 * 関係図の入口（#89。設計の下書き 4.2・6・7 節。見た目は mock.html の `drawNode`・`drawGraph`）。
 * 外に出すのは `window.touryouGraph` の `draw(host, view)`・`destroy()` だけ。`draw` は、表示モデルから「整えた文字・確かめた ID・数」だけを作り直して描く。
 * 表示モデルをそのまま rete に渡さない。rete のノード・つながりのデータは、ID と数だけ。
 * 描画のプラグインは使わず、area のプラグインの `render` の合図を受けて、箱は `el`、線は `svgEl` で自前に描く（R0）。
 */

import { type GetSchemes, NodeEditor } from "rete";
import { AreaPlugin } from "rete-area-plugin";
import { ReadonlyPlugin } from "rete-readonly-plugin";
import { type LayoutPos, layoutOf } from "./graph-layout.js";
import {
  ageClassOf,
  type GraphLane,
  type GraphNode,
  graphModelOf,
  laneAgoText,
  roleAgoText,
  stageText,
} from "./graph-model.js";
import {
  COMET_TAIL,
  cometSpanOf,
  type Lane,
  laneOf,
  roleIconOf,
  trunkOf,
  twigOf,
} from "./graph-path.js";
import { graphString, type Lang } from "./graph-text.js";
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
  /** 線の title（言葉と段。描く言語で作っておく）。 */
  readonly title?: string;
  /** 札の元（時刻なしの札は、時刻が動かない）。「何分前」だけを nowMs から計算し直すために持つ（#204）。 */
  readonly ago?: { readonly arrow: string; readonly label: string; readonly at: number };
}

/**
 * 「何分前」の文字を計算し直す更新（#204）。描いた要素ごとに 1 つ。画面ごと描き直さずに、文字と濃さのクラスだけを書き換える
 * （箱・線は作り直さないので、浮かび・focus・拡大・移動はそのまま）。要素が図から外れていたら false を返す（一覧から外す）。
 */
type AgoTick = (now: number) => boolean;

/** 更新の間隔。背面のタブはブラウザが間引くので、前面に戻ったとき・focus のときにも、すぐ計算し直す。 */
const AGO_TICK_MS = 15000;

let current: AreaPlugin<Schemes, never> | null = null;
/** いまの図の合図の受け手を、まとめて外すためのもの（`destroy` で外す）。 */
let listening: AbortController | null = null;
/** 「何分前」を計算し直す interval（#204）。描き直し・`destroy` の `teardown` で止める。 */
let agoTimer: number | null = null;
let currentHost: HTMLElement | null = null;
/** 描きの番号（世代）。`draw`・`destroy` のたびに進む。古い `draw` の続きは、番号が違えば黙って抜ける。 */
let generation = 0;
/**
 * 指を置いている箱・キーボードで focus している箱の ID と、図の上の指の位置（画面の座標）。描き直しをまたいで覚えておき、
 * 描き直したあと、同じ ID の箱があれば浮かびをすぐに付け直す（描き直しのたびに図が元の明るさに戻って点滅しないため）。
 */
let hoverId: string | null = null;
let focusId: string | null = null;
let pointer: { readonly x: number; readonly y: number } | null = null;
/** 描き直しで残す、拡大・移動（同じ器に描き直すときだけ使う）。 */
let kept: {
  readonly host: HTMLElement;
  readonly k: number;
  readonly x: number;
  readonly y: number;
} | null = null;

/** いまの図を消す（描いていなければ何もしない）。描いている途中の `draw` も、そこで止まる。 */
export function destroy(): void {
  teardown();
  currentHost?.classList.remove("hot");
  currentHost = null;
  hoverId = null;
  focusId = null;
  pointer = null;
  kept = null;
}

/** 図を片付ける。器の浮かびの印（hot）と、覚えた ID・指の位置・拡大・移動は残す（描き直しの前に使う）。 */
function teardown(): void {
  generation += 1;
  // 先に合図の受け手を外す（器を空にしたときの blur などで、覚えた ID を消さないため）
  listening?.abort();
  listening = null;
  if (agoTimer !== null) window.clearInterval(agoTimer);
  agoTimer = null;
  if (current !== null && currentHost !== null) {
    const t = current.area.transform;
    kept = { host: currentHost, k: t.k, x: t.x, y: t.y };
  }
  current?.destroy();
  current = null;
  currentHost?.replaceChildren(); // area の器も片付ける
}

/** 拡大の下限と上限（ホイールも、ボタンも同じ。小さすぎる・大きすぎる図にしない）。 */
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2;
/** 「全体を見る」の倍率：字が小さくなっても、図の全部を枠に収める（0.25 倍まで）。 */
let fitK = 1;
/** 初めの形の倍率の下限（利用者の決め：初めは読める大きさ。収まらない分は、図をつかんで動かして見る）。 */
const FIRST_MIN = 0.5;
/**
 * 「全体を見る」と初めの形で、図の上に空ける高さ（右上の「＋」「−」「全体を見る」のボタン 34px と、その上下の間）。
 * 右上の箱がボタンの下に隠れないように。拡大・移動したあとは、重なってもよい。
 */
const FIT_TOP = 48;
/** 図の下に足す余白（いちばん下の枝の札が、枠の下の縁で切れないように。図の中の下の余白〔MARGIN〕に足す）。 */
const FIT_BOTTOM = 16;
const clampZoom = (k: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k));

/**
 * いまの図を、枠の真ん中を中心に `f` 倍する（上限・下限で止める）。描いていなければ何もしない。
 * ゆっくり動かさず、すぐ変える（動きを止める設定でも同じ）。
 */
async function zoomBy(f: number): Promise<void> {
  const a = current;
  const h = currentHost;
  if (a === null || h === null || !Number.isFinite(f) || f <= 0) return;
  const k = a.area.transform.k;
  const nk = clampZoom(k * f);
  if (nk === k) return;
  // ホイールと同じ数え方（rete の Zoom の wheel）：原点は、中身の左上から見た、枠の真ん中
  const hr = h.getBoundingClientRect();
  const cr = a.area.content.holder.getBoundingClientRect();
  const delta = nk / k - 1;
  await a.area.zoom(
    nk,
    (cr.left - (hr.left + hr.width / 2)) * delta,
    (cr.top - (hr.top + hr.height / 2)) * delta,
  );
}

/** 「全体を見る」：図の全部を枠に収める倍率と、左上（右上のボタンの分だけ下）に置く。描いていなければ何もしない。 */
async function fitView(): Promise<void> {
  const a = current;
  if (a === null) return;
  await a.area.zoom(fitK, 0, 0);
  await a.area.translate(0, FIT_TOP);
}

/**
 * 描いた図の、画面での大きさ（枠に合わせた倍率のもの。枠の高さを中身に合わせるのに使う）と、拡大・縮小の操作。
 * 操作は、画面のボタンから呼ぶ（外に出すグローバルは `draw`・`destroy` のまま増やさない）。返した描きの図にだけ効き、
 * そのあと描き直した・片付けたあとは何もしない。
 */
export interface Drawn {
  readonly width: number;
  readonly height: number;
  /** 枠の真ん中を中心に `f` 倍する（`ZOOM_MIN`〜`ZOOM_MAX` で止める）。 */
  readonly zoomBy: (f: number) => Promise<void>;
  /** 初めて描いたときの形に戻す。 */
  readonly fit: () => Promise<void>;
}

/** `draw` の 3 つめの引数。グローバルを増やさず、画面からの受け手をここで受ける。 */
export interface DrawOptions {
  /** 箱を押した（クリック・Enter・Space）とき、その子のノード ID（`ID_PATTERN` を通したもの）を渡す。 */
  readonly onPick?: (nodeId: string) => void;
  /** 図の言葉の言語（#140。画面の設定の言語）。ほかの値・なしは日本語。 */
  readonly lang?: Lang;
  /** 止めた・済んだ子を隠す（#206）。隠した数は、図の左上に出す。真のとき以外は、すべて出す。 */
  readonly hideFinished?: boolean;
}

/**
 * 図を描く。前の図（描いている途中のものも）は消してから描く。
 * 途中で次の `draw` か `destroy` が呼ばれたら、例外を出さずに抜ける（取り残さない。そのときは大きさ 0 を返す）。
 * 枠の幅に合わせて縮める（大きくはしない）。拡大・移動は、そのあとも人が変えられる。
 */
export async function draw(
  host: HTMLElement,
  view: unknown,
  options: DrawOptions = {},
): Promise<Drawn> {
  if (currentHost !== host) destroy();
  else teardown();
  const mine = generation;
  const ac = new AbortController();
  listening = ac;
  const opt = { signal: ac.signal };
  const onPick = typeof options.onPick === "function" ? options.onPick : null;
  const lang: Lang = options.lang === "en" ? "en" : "ja";
  // 「何分前」の更新（#204）。interval・前面に戻ったとき・focus で、描き直さずに文字だけ計算し直す。
  // 受け手は `ac` につなぐので、描き直し・`destroy` で外れる（interval も止まる）
  let ticks: AgoTick[] = [];
  const retick = (): void => {
    const now = Date.now();
    ticks = ticks.filter((t) => t(now));
  };
  agoTimer = window.setInterval(retick, AGO_TICK_MS); // 描き直し・destroy の teardown で止める
  document.addEventListener(
    "visibilitychange",
    () => {
      if (!document.hidden) retick();
    },
    opt,
  );
  window.addEventListener("focus", retick, opt);
  /** つながりの器と、その両端のノード ID（指を置いた箱の線だけ浮かべる）。 */
  const wires: { el: HTMLElement; a: string; b: string }[] = [];
  const litId = (): string | null => hoverId ?? focusId;
  const touches = (w: { a: string; b: string }, id: string | null): boolean =>
    id !== null && (w.a === id || w.b === id);
  const hot = (): void => {
    const id = litId();
    host.classList.toggle("hot", id !== null);
    for (const w of wires) w.el.classList.toggle("lit", touches(w, id));
  };
  // 図の上の指の位置を覚える（描き直したあと、どの箱の上にいるかを決めるため）
  host.addEventListener(
    "pointermove",
    (e) => {
      pointer = { x: e.clientX, y: e.clientY };
    },
    opt,
  );
  host.addEventListener(
    "pointerleave",
    () => {
      pointer = null;
    },
    opt,
  );
  const live = (): boolean => mine === generation;
  // 返す操作は、この描きの図にだけ効く（あとで描き直した・片付けたあとに古い操作を呼んでも、何もしない）
  const ctl = {
    zoomBy: (f: number): Promise<void> => (live() ? zoomBy(f) : Promise.resolve()),
    fit: (): Promise<void> => (live() ? fitView() : Promise.resolve()),
  };
  const none: Drawn = { width: 0, height: 0, ...ctl };
  const now = Date.now();
  const model = graphModelOf(view, lang, { hideFinished: options.hideFinished === true });
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
      const mine = model.lanes.filter((l) => l.parent === pid && l.child === kid);
      if (mine.length === 0) add({ kind: "twig", d: twigOf(P, C) }, pid, kid);
      for (const l of mine) {
        const s = laneShape(l, laneOf(P, C, l.dir), byId.get(kid), now, lang);
        add(s, l.dir === "up" ? kid : pid, l.dir === "up" ? pid : kid);
      }
    });
  }
  // 人の箱は置かない（利用者の決め）。人の答えなどは、親から子への下りの線の札で表す
  const width = L.width;
  const height = L.height;

  const editor = new NodeEditor<Schemes>();
  const area = new AreaPlugin<Schemes, never>(host);
  current = area;
  currentHost = host;
  const readonly = new ReadonlyPlugin<Schemes>();
  editor.use(readonly.root);
  editor.use(area);
  area.use(readonly.area);
  // 隠した数（#206）。図の左上の空き（右上のボタンと同じ、上の空き）に、図の外の飾りとして置く。片付けは器ごと（`teardown`）
  if (model.hidden > 0)
    host.append(el("div", "ghidden", graphString(lang, "graph.hidden", { n: model.hidden })));
  // 背景：親の幹（どのノード・つながりにも属さないので、area の中身にじかに置く）
  area.area.content.add(drawBackdrop(trunks, width, height));

  area.addPipe((ctx) => {
    // 拡大は、ホイールもボタンも、同じ下限・上限で止める
    if (ctx.type === "zoom") {
      const d = ctx.data as { zoom: number };
      return { ...ctx, data: { ...ctx.data, zoom: clampZoom(d.zoom) } } as typeof ctx;
    }
    if (ctx.type !== "render") return ctx;
    const { element, type, payload } = ctx.data as {
      element: HTMLElement;
      type: string;
      payload: { id: string };
    };
    if (type === "node") {
      const n = byId.get(payload.id);
      const box = drawNode(element, n, now, lang, ticks);
      if (box !== null && n !== undefined) listen(box, n.id);
    } else if (type === "connection") {
      const c = payload as ReteConn;
      drawShape(element, shapes[c.shape], width, height, lang, ticks);
      const w = { el: element, a: c.source, b: c.target };
      // 描き直しの最中も、覚えた箱の線は浮かべたまま（器の hot は残してある）
      if (touches(w, litId())) element.classList.add("lit");
      wires.push(w);
    }
    return ctx;
  });

  /** 箱の合図の受け手（`addEventListener` だけ。`destroy` で `ac` ごと外れる）。 */
  function listen(box: HTMLElement, id: string): void {
    box.tabIndex = 0;
    box.addEventListener(
      "pointerenter",
      () => {
        hoverId = id;
        hot();
      },
      opt,
    );
    box.addEventListener(
      "pointerleave",
      () => {
        if (hoverId === id) hoverId = null;
        hot();
      },
      opt,
    );
    box.addEventListener(
      "focus",
      () => {
        focusId = id;
        hot();
      },
      opt,
    );
    box.addEventListener(
      "blur",
      () => {
        if (focusId === id) focusId = null;
        hot();
      },
      opt,
    );
    if (onPick === null) return;
    box.addEventListener("click", () => onPick(id), opt);
    box.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onPick(id);
      },
      opt,
    );
  }

  for (const n of model.nodes) {
    await editor.addNode({ id: n.id });
    if (!live()) return none;
  }
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
  readonly.enable(); // 置いたあとは、つなぐ・動かす・消すを止める（拡大・移動は残る）
  // 枠の幅と高さ（CSS の max-height。上の空き〔ボタン〕と下の余白を含む）に収まる倍率。大きくはしない。
  const maxH = Number.parseFloat(getComputedStyle(host).maxHeight);
  const byHeight = Number.isFinite(maxH) ? (maxH - FIT_TOP - FIT_BOTTOM) / height : 1;
  const fits = Math.min(1, host.clientWidth / width, byHeight);
  // 初めの形は、読める大きさ（0.5 倍）より小さくしない。「全体を見る」は、0.25 倍まで縮めて全部を収める
  const k = Math.max(FIRST_MIN, fits);
  fitK = clampZoom(fits);
  // 同じ器への描き直しなら、人が変えた拡大・移動をそのまま残す（初めて描くときだけ、枠に合わせる）
  const keep = kept !== null && kept.host === host ? kept : null;
  kept = null;
  await area.area.zoom(keep?.k ?? k, 0, 0);
  if (!live()) return none;
  await area.area.translate(keep?.x ?? 0, keep?.y ?? FIT_TOP);
  if (!live()) return none;
  relight(host, byId, hot);
  // 返す大きさは、枠に合わせた倍率（k）のもの。人が拡大・縮小したあとの描き直しでも、枠の高さは初めて描いたときの
  // 大きさのまま保つ（描き直しのたびに枠の高さが変わって、ページが跳ねないように）
  // 高さは、上の空き（ボタン）と下の余白を含む。画面は、この高さで枠の高さを決める
  return { width: width * k, height: height * k + FIT_TOP + FIT_BOTTOM, ...ctl };
}

/**
 * 描き直したあとの浮かびを決め直して、`transition` なしで付ける（1 枚も元の明るさに戻さない）。
 * 指の位置の下の箱を指を置いた箱とし、focus していた箱があれば focus を戻す。その箱がなくなっていれば外す。
 */
function relight(host: HTMLElement, byId: ReadonlyMap<string, unknown>, hot: () => void): void {
  const under =
    pointer === null
      ? null
      : (document.elementFromPoint(pointer.x, pointer.y)?.closest<HTMLElement>(".gnode[data-id]") ??
        null);
  const id = under?.dataset.id;
  hoverId = id !== undefined && byId.has(id) && host.contains(under) ? id : null;
  if (focusId !== null) {
    const was = focusId;
    const box = byId.has(was)
      ? [...host.querySelectorAll<HTMLElement>(".gnode[data-id]")].find((b) => b.dataset.id === was)
      : undefined;
    focusId = null;
    // 描いている途中に、人がほかの所（答えの欄など）へ focus を移していたら、奪わない。
    // 戻すのは、focus がどこにもない（片付けで箱ごと消えた）か、器の中にあるときだけ
    const active = document.activeElement;
    const free = active === null || active === document.body || host.contains(active);
    if (box !== undefined && free) box.focus({ preventScroll: true }); // focus の合図で focusId が戻る
  }
  host.classList.add("g-instant");
  hot();
  void host.offsetWidth; // 印を付けた見た目を先に確定させてから、transition を戻す
  host.classList.remove("g-instant");
}

/** 線 1 本の形と見え方。終わった作業の線は止める。人の答えを待つものだけ柿色（`wait`）。 */
function laneShape(
  l: GraphLane,
  lane: Lane,
  child: GraphNode | undefined,
  now: number,
  lang: Lang,
): Shape {
  const finished = child?.tier === "over";
  const stage = finished ? "done" : l.stage === "sent" && l.unknown ? "unknown" : l.stage;
  // 新しいほど濃い（a1〜a4）。答え待ちの柿色（wait）と、終わった子の薄い灰（over）は、CSS でこれを上書きする
  const extra = ` ${ageClassOf(l.at, now)}${l.waiting && !finished ? " wait" : ""}${finished ? " over" : ""}`;
  const arrow = l.dir === "up" ? "← " : "→ ";
  const label = l.at === null ? `${arrow}${l.label}` : laneAgoText(arrow, l.label, l.at, now, lang);
  const stageWords = stageText(l, lang);
  return {
    kind: "lane",
    d: lane.d,
    lane,
    look: `${l.dir}${extra} g-${stage}`,
    label,
    stage: stageWords,
    title: graphString(lang, "graph.lineTitle", { label, stage: stageWords }),
    ...(l.at === null ? {} : { ago: { arrow, label: l.label, at: l.at } }),
  };
}

function drawBackdrop(trunks: readonly string[], w: number, h: number): HTMLElement {
  const box = el("div", "gback");
  const svg = svgEl("svg", { class: "glink", width: w, height: h, viewBox: `0 0 ${w} ${h}` });
  // 列の見出し（いちばん上の統合・子・孫）は置かない（利用者の決め。親子は線と箱の位置で分かる）
  for (const d of trunks) svg.append(svgEl("path", { class: "trunk", d }));
  box.append(svg);
  return box;
}

/** 箱（見本の `drawNode`）：題・役割の印と「何分前」・状態の言葉と印・動いている点・人の答えの数。 */
function drawNode(
  element: HTMLElement,
  n: GraphNode | undefined,
  now: number,
  lang: Lang,
  ticks: AgoTick[],
): HTMLElement | null {
  if (n === undefined) return null;
  element.replaceChildren();
  const box = el("div", `gnode t-${n.tier} s-${n.status}`);
  box.dataset.id = n.id;
  box.role = "button";
  box.ariaLabel = graphString(lang, "graph.boxLabel", { title: n.title, status: n.statusText });
  const row = el("div", "gr");
  const icon = svgEl("svg", { class: "gic", width: 12, height: 12, viewBox: "0 0 12 12" });
  icon.append(svgEl("path", { class: "role-ic", d: roleIconOf(n.integrator) }));
  const gs = el(
    "span",
    "gs",
    n.lastAt === null ? n.role : roleAgoText(n.role, n.lastAt, now, lang),
  );
  // 配下の数を添えた役割の名前は長いので、省略されたときに全文を見られるようにする（#168）
  gs.title = n.role;
  if (n.lastAt !== null) {
    const { role, lastAt } = n;
    ticks.push((t) => {
      if (!gs.isConnected) return false;
      const text = roleAgoText(role, lastAt, t, lang);
      if (gs.textContent !== text) gs.textContent = text;
      return true;
    });
  }
  row.append(icon, gs);
  box.append(el("span", "gt", n.title), row, el("span", `gst st-${n.status}`, n.statusText));
  if (n.alive) box.append(el("span", "galive"));
  if (n.needsHuman > 0) {
    const b = el("span", "gbadge", String(n.needsHuman));
    box.append(b);
  }
  element.append(box);
  return box;
}

function drawShape(
  element: HTMLElement,
  s: Shape | undefined,
  w: number,
  h: number,
  lang: Lang,
  ticks: AgoTick[],
): void {
  if (s === undefined) return;
  element.replaceChildren();
  const svg = svgEl("svg", { class: "glink", width: w, height: h, viewBox: `0 0 ${w} ${h}` });
  if (s.kind === "twig") svg.append(svgEl("path", { class: "twig", d: s.d }));
  else if (s.lane !== undefined) {
    const lane = s.lane;
    const look = s.look ?? "";
    const line = svgEl("path", { class: `line ${look}`, d: s.d });
    line.append(svgEl("title", {}, s.title ?? ""));
    svg.append(line);
    // 彗星は g-sent の線だけ。線と同じ `d` の重ね線に、尾の薄い窓（mask）をかけて走らせる
    if (look.endsWith("g-sent")) svg.append(...cometOf(s.d, w, h));
    svg.append(svgEl("path", { class: `tip ${look}`, d: lane.tip }));
    if (lane.portX !== undefined && lane.portY !== undefined)
      svg.append(
        svgEl("rect", {
          class: `port ${look}`,
          x: lane.portX - 3.5,
          y: lane.portY - 3.5,
          width: 7,
          height: 7,
          rx: 1,
        }),
      );
    const mlabel = svgEl(
      "text",
      { class: `mlabel ${look}`, x: lane.labelX, y: lane.labelY },
      s.label ?? "",
    );
    const mstage = svgEl(
      "text",
      { class: `mstage ${look}`, x: lane.labelX, y: lane.stageY },
      s.stage ?? "",
    );
    svg.append(mlabel, mstage);
    if (s.ago !== undefined) {
      const { arrow, label, at } = s.ago;
      const title = line.querySelector("title");
      // 札の文字・線の title・線の濃さ（新しいほど濃い。a1〜a4）を、nowMs から計算し直す（作り直さない）
      const aged = [line, ...svg.querySelectorAll<SVGElement>(".tip, .port"), mlabel, mstage];
      ticks.push((now) => {
        if (!mlabel.isConnected) return false;
        const text = laneAgoText(arrow, label, at, now, lang);
        if (mlabel.textContent !== text) {
          mlabel.textContent = text;
          if (title !== null)
            title.textContent = graphString(lang, "graph.lineTitle", {
              label: text,
              stage: s.stage ?? "",
            });
        }
        const age = ageClassOf(at, now);
        for (const e of aged) {
          if (e.classList.contains(age)) continue;
          e.classList.remove("a1", "a2", "a3", "a4");
          e.classList.add(age);
        }
        return true;
      });
    }
  }
  element.append(svg);
}

/** 彗星の mask・グラデーションの `id` の通し番号（線ごとに一意にする）。 */
let cometSeq = 0;

/**
 * 線 `d` の上を走る彗星：defs（グラデーション・mask）と、`d` と同じ形の重ね線。
 * mask の中の窓（rect）は、走る範囲＋尾の長さ。CSS の translate（幅の 100%）で動かす。
 * 窓は幅が 0 でない rect なので、水平・垂直の線でも描かれる。
 */
function cometOf(d: string, w: number, h: number): SVGElement[] {
  const { from, to } = cometSpanOf(d);
  const seq = ++cometSeq;
  const fade = `comet-fade-${seq}`;
  const mask = `comet-mask-${seq}`;
  const right = to >= from;
  const len = Math.abs(to - from);
  const span = len + COMET_TAIL;
  // 頭が最も明るく、尾が薄れる（0 透明 → 70% で .8 → 95% で 1 → 100% で透明）。頭は進む向きの端
  const t = COMET_TAIL / span;
  const stops: readonly (readonly [number, string])[] = right
    ? [
        [0, "comet-clear"],
        [1 - t, "comet-clear"],
        [1 - t + 0.7 * t, "comet-mid"],
        [1 - t + 0.95 * t, "comet-lit"],
        [1, "comet-clear"],
      ]
    : [
        [0, "comet-clear"],
        [0.05 * t, "comet-lit"],
        [0.3 * t, "comet-mid"],
        [t, "comet-clear"],
        [1, "comet-clear"],
      ];
  const gradient = svgEl("linearGradient", { id: fade });
  for (const [offset, cls] of stops) gradient.append(svgEl("stop", { offset, class: cls }));
  const win = svgEl("rect", {
    class: right ? "comet-win" : "comet-win comet-win-left",
    x: right ? from - span : from,
    y: 0,
    width: span,
    height: h,
    fill: `url(#${fade})`,
  });
  const maskEl = svgEl("mask", {
    id: mask,
    maskUnits: "userSpaceOnUse",
    x: 0,
    y: 0,
    width: w,
    height: h,
  });
  maskEl.append(win);
  const defs = svgEl("defs");
  defs.append(gradient, maskEl);
  return [defs, svgEl("path", { class: "comet", d, mask: `url(#${mask})` })];
}
