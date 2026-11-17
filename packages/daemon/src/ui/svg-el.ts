/**
 * SVG を作るのは、この 1 か所だけ（#89。設計の下書き 6 節）。
 * タグ・属性は許可リスト。値は数か、数で組んだ `d`（命令 M・L・C・Q・A・Z）か、`viewBox` の数か、`SVG_CLASSES` の名前だけ。
 * 文字は `text`・`title` の `textContent` だけで入れる。
 */
const NS = "http://www.w3.org/2000/svg";
const TAGS: ReadonlySet<string> = new Set(["svg", "g", "path", "rect", "text", "title"]);
const NUMERIC: ReadonlySet<string> = new Set(["x", "y", "width", "height", "rx"]);
/** `class` に使ってよい名前（決まった一覧だけ。空白で区切って複数）。 */
export const SVG_CLASSES: ReadonlySet<string> = new Set([
  "glink",
  "twig",
  "line",
  "tip",
  "mlabel",
  "up",
  "down",
  "human",
  "wait",
  "g-sent",
  "g-unknown",
  "g-delivered",
  "g-done",
]);
/** `d` に許す形：命令 M・L・C・Q・A・Z と、数・空白だけ。 */
export const PATH_PATTERN = /^(?:[MLCQAZ]|-?\d+(?:\.\d+)?|[ ,])*$/;
const VIEWBOX_PATTERN = /^-?\d+(?:\.\d+)? -?\d+(?:\.\d+)? \d+(?:\.\d+)? \d+(?:\.\d+)?$/;

export type SvgAttrs = Readonly<Record<string, string | number>>;

/** 許した値だけを文字にする。合わなければ例外（黙って描かない）。 */
export function svgAttrValue(name: string, v: string | number): string {
  if (NUMERIC.has(name)) {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`svgEl: ${name}`);
    return String(Math.round(v * 10) / 10);
  }
  if (typeof v !== "string") throw new Error(`svgEl: ${name}`);
  if (name === "class") {
    const names = v.split(" ").filter((c) => c !== "");
    if (names.length > 0 && names.every((c) => SVG_CLASSES.has(c))) return names.join(" ");
  }
  if (name === "d" && v.length <= 20000 && PATH_PATTERN.test(v)) return v;
  if (name === "viewBox" && VIEWBOX_PATTERN.test(v)) return v;
  throw new Error(`svgEl: ${name}`);
}

export function svgEl(tag: string, attrs: SvgAttrs = {}, text?: string): SVGElement {
  if (!TAGS.has(tag)) throw new Error(`svgEl: ${tag}`);
  const e = document.createElementNS(NS, tag);
  for (const k of Object.keys(attrs)) {
    const v = attrs[k];
    if (v === undefined) continue;
    e.setAttributeNS(null, k, svgAttrValue(k, v));
  }
  if (text !== undefined) {
    if (tag !== "text" && tag !== "title") throw new Error(`svgEl: text in ${tag}`);
    e.textContent = text;
  }
  return e;
}
