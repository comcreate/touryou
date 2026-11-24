import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { UI_APP_JS, UI_CSS, UI_HTML, UI_JS } from "../../src/api/ui-assets.js";
import { UI_BG_JS } from "../../src/api/ui-bg-webgl.js";

type Listener = (e?: unknown) => void;

interface Options {
  /** getContext が null を返す（WebGL なし） */
  noGl?: boolean;
  classes?: string[];
  reducedMotion?: boolean;
  dark?: boolean;
  hidden?: boolean;
}

/** 背景の script を、最小の DOM・WebGL の代役の中で動かす。 */
function run(opts: Options = {}) {
  const classes = new Set(opts.classes ?? []);
  const media = { reducedMotion: opts.reducedMotion === true, dark: opts.dark === true };
  const mqListeners: Listener[] = [];
  const canvasListeners = new Map<string, Listener>();
  const docListeners = new Map<string, Listener>();
  const frames: Array<(now: number) => void> = [];
  let observer: Listener = () => {};
  const draws: Array<{ time: number; dark: number }> = [];
  let time = 0;
  let dark = 0;
  let compileOk = true;

  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    TRIANGLES: 8,
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => compileOk,
    deleteShader: () => {},
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: () => {},
    getAttribLocation: () => 0,
    getUniformLocation: (_p: unknown, name: string) => name,
    useProgram: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    viewport: () => {},
    uniform2f: () => {},
    uniform1f: (name: string, v: number) => {
      if (name === "u_time") time = v;
      if (name === "u_isDark") dark = v;
    },
    drawArrays: () => draws.push({ time, dark }),
  };

  const canvas = {
    hidden: true,
    width: 0,
    height: 0,
    clientWidth: 800,
    clientHeight: 600,
    getContext: () => (opts.noGl ? null : gl),
    addEventListener: (type: string, fn: Listener) => canvasListeners.set(type, fn),
  };
  const doc = {
    hidden: opts.hidden === true,
    documentElement: { classList: { contains: (c: string) => classes.has(c) } },
    getElementById: (id: string) => (id === "bg-gl" ? canvas : null),
    addEventListener: (type: string, fn: Listener) => docListeners.set(type, fn),
  };
  const matchMedia = (q: string) => ({
    get matches() {
      return q.includes("reduced-motion") ? media.reducedMotion : media.dark;
    },
    addEventListener: (_t: string, fn: Listener) => mqListeners.push(fn),
  });
  const sandbox = {
    document: doc,
    window: {
      devicePixelRatio: 3,
      innerWidth: 800,
      innerHeight: 600,
      matchMedia,
      addEventListener: () => {},
    },
    MutationObserver: class {
      constructor(fn: Listener) {
        observer = fn;
      }
      observe() {}
    },
    requestAnimationFrame: (fn: (now: number) => void) => frames.push(fn),
    cancelAnimationFrame: (id: number) => {
      frames[id - 1] = () => {};
    },
    Float32Array,
    Math,
  };
  vm.runInNewContext(UI_BG_JS, sandbox);

  const tick = (now: number) => {
    const fn = frames.shift();
    fn?.(now);
  };
  return {
    canvas,
    draws,
    frames,
    tick,
    setClass: (c: string, on: boolean) => {
      if (on) classes.add(c);
      else classes.delete(c);
      observer();
    },
    setReducedMotion: (on: boolean) => {
      media.reducedMotion = on;
      for (const fn of mqListeners) fn();
    },
    setHidden: (on: boolean) => {
      doc.hidden = on;
      docListeners.get("visibilitychange")?.();
    },
    fire: (type: string, e: unknown = { preventDefault: () => {} }) => canvasListeners.get(type)?.(e),
  };
}

describe("全面の背景（WebGL）: 描くとき", () => {
  it("動いてよいときは、canvas を出して描く", () => {
    const r = run();
    expect(r.canvas.hidden).toBe(false);
    r.tick(0);
    expect(r.draws).toHaveLength(1);
    r.tick(16);
    expect(r.draws).toHaveLength(2);
  });

  it("時間は積み上げで、1 回に進めるのは 0.1 秒まで。解像度は devicePixelRatio の上限 2 まで", () => {
    const r = run();
    r.tick(1000);
    r.tick(60000); // 隠れたタブから戻ったような大きな間
    expect(r.draws[1]?.time).toBeCloseTo(24.1, 5);
    expect(r.canvas.width).toBe(1600);
    expect(r.canvas.height).toBe(1200);
  });

  it("明暗は、html の設定（theme-dark・theme-light）が先。なければ OS に合わせる", () => {
    const dark = run({ classes: ["theme-dark"] });
    dark.tick(0);
    expect(dark.draws[0]?.dark).toBe(1);
    const light = run({ classes: ["theme-light"], dark: true });
    light.tick(0);
    expect(light.draws[0]?.dark).toBe(0);
    const os = run({ dark: true });
    os.tick(0);
    expect(os.draws[0]?.dark).toBe(1);
  });
});

describe("全面の背景（WebGL）: 描かずに静かな背景（CSS の色）へ落ちる", () => {
  it("WebGL がない", () => {
    const r = run({ noGl: true });
    expect(r.canvas.hidden).toBe(true);
    expect(r.frames).toHaveLength(0);
    expect(r.draws).toHaveLength(0);
  });

  it("「動きを止める」（html.still）では描かない。外すと描き始める", () => {
    const r = run({ classes: ["still"] });
    expect(r.canvas.hidden).toBe(true);
    expect(r.frames).toHaveLength(0);
    r.setClass("still", false);
    expect(r.canvas.hidden).toBe(false);
    r.tick(0);
    expect(r.draws).toHaveLength(1);
  });

  it("動いている途中で止めると、次のフレームを取り消して canvas を隠す", () => {
    const r = run();
    r.tick(0);
    r.setClass("still", true);
    expect(r.canvas.hidden).toBe(true);
    r.tick(16);
    expect(r.draws).toHaveLength(1);
  });

  it("OS の「視差効果を減らす」では描かない", () => {
    const r = run({ reducedMotion: true });
    expect(r.canvas.hidden).toBe(true);
    expect(r.draws).toHaveLength(0);
    r.setReducedMotion(false);
    expect(r.canvas.hidden).toBe(false);
  });

  it("ページが見えないあいだは描かない（visibilitychange）。見えたら戻る", () => {
    const r = run();
    r.tick(0);
    r.setHidden(true);
    expect(r.canvas.hidden).toBe(true);
    r.tick(16);
    expect(r.draws).toHaveLength(1);
    r.setHidden(false);
    expect(r.canvas.hidden).toBe(false);
    r.tick(32);
    expect(r.draws).toHaveLength(2);
  });

  it("ページが見えない状態で始まったときは、見えるまで描かない", () => {
    const r = run({ hidden: true });
    expect(r.canvas.hidden).toBe(true);
    expect(r.frames).toHaveLength(0);
  });

  it("コンテキストを失ったら隠し、戻ったら描き直す", () => {
    const r = run();
    r.tick(0);
    let prevented = false;
    r.fire("webglcontextlost", { preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    expect(r.canvas.hidden).toBe(true);
    r.tick(16);
    expect(r.draws).toHaveLength(1);
    r.fire("webglcontextrestored");
    expect(r.canvas.hidden).toBe(false);
    r.tick(32);
    expect(r.draws).toHaveLength(2);
  });
});

describe("全面の背景（WebGL）: ページへの入れ方", () => {
  it("/ui/app.js（UI_APP_JS）に含まれ、別の経路を増やさない（script は app.js と graph.js の 2 つのまま）", () => {
    expect(UI_APP_JS).toBe(UI_JS + UI_BG_JS);
    expect(UI_APP_JS).toContain("getElementById('bg-gl')");
    expect(UI_HTML.match(/<script /g)).toHaveLength(2);
    expect(UI_HTML).not.toContain("bg-webgl.js");
  });

  it("canvas は aria-hidden で、最下層に固定し、操作・焦点を受けない", () => {
    expect(UI_HTML).toContain('<canvas id="bg-gl" aria-hidden="true" hidden></canvas>');
    const rule = /#bg-gl\{[^}]*\}/.exec(UI_CSS)?.[0] ?? "";
    expect(rule).toContain("position:fixed");
    expect(rule).toContain("z-index:-1");
    expect(rule).toContain("pointer-events:none");
    expect(UI_HTML).not.toMatch(/<canvas[^>]*tabindex/);
  });

  it("静かな背景は、body の CSS の色（var(--bg)）のまま。CSS に色の直書きを足していない", () => {
    expect(UI_CSS).toContain("body{margin:0;background:var(--bg);");
    const rule = /#bg-gl\{[^}]*\}/.exec(UI_CSS)?.[0] ?? "";
    expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}|rgba?\(/);
  });

  it("CSP の script-src 'self' のまま動く（インラインの script・eval・外部の読み込みを使わない）", () => {
    expect(UI_BG_JS).not.toMatch(/eval\(|new Function|importScripts|fetch\(|XMLHttpRequest/);
  });
});
