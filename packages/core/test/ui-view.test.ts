import { describe, expect, it } from "vitest";
import {
  type EventBody,
  foldEvents,
  isStallSummary,
  type OrchEvent,
  type OrchState,
  stallSummary,
  UI_CUT_MARK,
  UI_FLOW_TEXT_MAX,
  UI_LIMITS,
  UI_OPTION_MAX,
  UI_QUESTION_MAX,
  UI_TARGET_MAX,
  UI_TEXT_MAX,
  UI_TITLE_MAX,
  uiTargetOf,
  uiText,
  uiViewOf,
} from "../src/index.js";

const SYS = { system: true } as const;
const AT = "2026-10-20T00:00:00Z";
let n = 0;
const ev = (body: EventBody, at = AT): OrchEvent =>
  ({ seq: ++n, at, requestId: `r${n}`, actor: SYS, ...body }) as OrchEvent;
const created = (
  nodeId: string,
  role: "integrator" | "implement",
  parentId: string | null,
  extra = {},
) =>
  ev({
    type: "node.created",
    payload: { nodeId, role, parentId, dependsOn: [], ...extra },
  } as never);
const added = (id: string, kind: string, nodeId: string, extra: Record<string, unknown> = {}) =>
  ev({ type: "inbox.added", payload: { id, kind, nodeId, ...extra } } as never);
const must = (events: OrchEvent[]): OrchState => {
  const r = foldEvents(events);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.cause}`);
  return r.value;
};
const base = (): OrchEvent[] => {
  n = 0;
  return [
    created("root", "integrator", null),
    ev({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } }),
    created("a", "implement", "root"),
  ];
};

describe("uiViewOf の stopDelegated", () => {
  it("渡した判定が真のノードにだけ stopDelegated を付ける。省略すると付けない", () => {
    const s = must(base());
    const v = uiViewOf(s, { stopDelegated: (id) => id === "a" });
    expect(v.nodes.find((x) => x.id === "a")?.stopDelegated).toBe(true);
    expect(v.nodes.find((x) => x.id === "root")).not.toHaveProperty("stopDelegated");
    for (const x of uiViewOf(s).nodes) expect(x).not.toHaveProperty("stopDelegated");
  });
});

describe("uiViewOf の cli（#136）", () => {
  it("親が起動（launch）を done で報告した子にだけ cli を付ける。failed・未報告・ほかの依頼には付けない", () => {
    const req = (ref: string, kind: string) =>
      ev({
        type: "node.parentRequested",
        payload: { nodeId: "a", requestRef: ref, kind, worktree: "/w/a" },
      } as never);
    const rep = (ref: string, outcome: string) =>
      ev({
        type: "node.parentReported",
        payload: { nodeId: "a", requestRef: ref, outcome },
      } as never);
    const of = (events: OrchEvent[]) => uiViewOf(must(events)).nodes.find((x) => x.id === "a");
    expect(of(base())).not.toHaveProperty("cli");
    expect(of([...base(), req("r1", "launch")])).not.toHaveProperty("cli");
    expect(of([...base(), req("r1", "launch"), rep("r1", "failed")])).not.toHaveProperty("cli");
    expect(of([...base(), req("r1", "launch"), rep("r1", "done")])?.cli).toBe(true);
  });
});

describe("uiViewOf（画面の表示モデル）", () => {
  it("ノード・未解決の項目（優先度の降順）・件数を返す。解決済みの項目は含めない", () => {
    const s = must([
      ...base(),
      added("p1", "progress", "a", { summary: "進んだ" }),
      added("f1", "failure", "a", { summary: "落ちた" }),
      added("i1", "info", "a"),
      ev({ type: "inbox.resolved", payload: { itemId: "i1" } }),
    ]);
    const v = uiViewOf(s);
    expect(v.nodes.map((x) => x.id)).toEqual(["root", "a"]);
    expect(v.nodes.find((x) => x.id === "a")?.openItems).toBe(2);
    expect(v.inbox.map((x) => x.id)).toEqual(["f1", "p1"]);
    expect(v.inbox[0]?.priority).toBe("failed");
    expect(v.lastSeq).toBe(s.lastSeq);
    expect(v.truncated).toEqual([]);
  });

  it("ブリーフ（受け入れ基準・作業範囲・目的の題より後ろ）・パス・最終コミットは、表示モデルに入らない（目的は先頭の題だけ。#89）", () => {
    const s = must([
      ...base().slice(0, 2),
      created("a", "implement", "root", {
        objective: `題の部分${"。".repeat(UI_TITLE_MAX)}SECRET-OBJECTIVE`,
        acceptanceCriteria: ["SECRET-CRITERIA"],
        scope: {
          writableLocations: ["src/secret-dir"],
          forbiddenLocations: [".git"],
          allowedCommands: ["pnpm test"],
        },
      }),
    ]);
    const json = JSON.stringify(uiViewOf(s));
    expect(json).not.toContain("SECRET");
    expect(json).not.toContain("secret-dir");
  });

  it("子が書いた文字列は、制御文字を除き、上限（UI_TEXT_MAX）に切る。識別子の形でないものは空にする", () => {
    expect(uiText("a\u0000b\u001bc\u007fd\nE\tF")).toBe("abcd\nE\tF"); // タブ・改行は残す
    expect(uiText("a\u202eb\u200bc")).toBe("abc"); // 書式制御文字（U+202E・ゼロ幅）は除く
    // 切ったら、末尾に印を付ける（印は、上限に数えない）
    expect(uiText("あ".repeat(UI_TEXT_MAX + 50))).toBe(`${"あ".repeat(UI_TEXT_MAX)}${UI_CUT_MARK}`);
    expect(uiText("あ".repeat(UI_TEXT_MAX))).toBe("あ".repeat(UI_TEXT_MAX)); // ちょうどなら、切らない
    expect(uiText("x".repeat(50), 10)).toBe(`${"x".repeat(10)}${UI_CUT_MARK}`); // 上限は、引数で渡す
    expect(uiText(undefined)).toBe("");
    const folded = must([...base(), added("p1", "progress", "a", { summary: "xy" })]);
    // 制御文字は、記録の検証で拒まれる。古い記録・壊れた状態に備えて、取り込んだあとの状態で確かめる
    const s: OrchState = {
      ...folded,
      inbox: folded.inbox.map((i) => ({ ...i, summary: "x\u0007y" })),
    };
    expect(uiViewOf(s).inbox[0]?.summary).toBe("xy");
    const bad: OrchState = {
      ...s,
      nodes: s.nodes.map((x) => (x.id === "a" ? { ...x, id: "<img src=x onerror=1>" } : x)),
    };
    expect(uiViewOf(bad).nodes.find((x) => x.role === "implement")?.id).toBe("");
  });

  it("未回答の判断・未判定の拡張要求を返す（回答済み・判定済みは含めない）。目標の場所（パス）は含めない", () => {
    const s = must(base());
    const withOpen: OrchState = {
      ...s,
      decisions: [
        {
          decisionId: "d1",
          nodeId: "a",
          status: "open",
          question: "どれにする？",
          options: ["A", "B"],
          rejected: [],
        } as never,
        { decisionId: "d2", nodeId: "a", status: "answered", rejected: [] } as never,
      ],
      extensions: [
        {
          extensionId: "x1",
          nodeId: "a",
          status: "open",
          reason: "足りない",
          target: { writableLocations: ["src/secret-dir"] },
        } as never,
        { extensionId: "x2", nodeId: "a", status: "approved", reason: "済み" } as never,
      ],
    };
    const v = uiViewOf(withOpen);
    expect(v.decisions).toEqual([
      {
        id: "d1",
        nodeId: "a",
        question: "どれにする？",
        options: [
          { text: "A", truncated: false },
          { text: "B", truncated: false },
        ],
        optionsCut: false,
      },
    ]);
    // 対象の形が不正（記録に target がない）なら、隠す（承認・切り出しをさせない）
    expect(v.extensions).toEqual([
      { id: "x1", nodeId: "a", reason: "足りない", targetHidden: true },
    ]);
    expect(JSON.stringify(v)).not.toContain("secret-dir");
  });

  it("判断の質問・選択肢の上限は、種類ごと: 質問は 2,000、選択肢は 500。切ったら印。切った・文字を除いた選択肢は、truncated（choice に、そのままは送れない）", () => {
    const s = must(base());
    const long = "あ".repeat(UI_OPTION_MAX + 1);
    const view = uiViewOf({
      ...s,
      decisions: [
        {
          decisionId: "d1",
          nodeId: "a",
          status: "open",
          question: "問".repeat(UI_QUESTION_MAX + 5),
          options: ["短い", "あ".repeat(UI_OPTION_MAX), long, "a\u202eb", "a\nb"],
          rejected: [],
        } as never,
        {
          decisionId: "d2",
          nodeId: "a",
          status: "open",
          question: "問".repeat(UI_QUESTION_MAX),
          options: Array.from({ length: 12 }, (_, i) => `o${i}`),
          rejected: [],
        } as never,
      ],
    });
    const d1 = view.decisions[0];
    // 質問は 2,000 まで読める（200 で切らない）。超えたら印
    expect(d1?.question).toBe(`${"問".repeat(UI_QUESTION_MAX)}${UI_CUT_MARK}`);
    expect(view.decisions[1]?.question).toBe("問".repeat(UI_QUESTION_MAX));
    expect(d1?.options).toEqual([
      { text: "短い", truncated: false },
      { text: "あ".repeat(UI_OPTION_MAX), truncated: false }, // 200 を超えても、500 までは、そのまま送れる
      { text: `${"あ".repeat(UI_OPTION_MAX)}${UI_CUT_MARK}`, truncated: true },
      { text: "ab", truncated: true }, // 書式制御文字を除いた（元の文字列とは違う）
      { text: "a\nb", truncated: false }, // 改行は残る（元のまま）
    ]);
    expect(d1?.optionsCut).toBe(false);
    // 選択肢が多いときは、上限（UI_LIMITS.options）まで。切ったことを示す
    expect(view.decisions[1]?.options).toHaveLength(UI_LIMITS.options);
    expect(view.decisions[1]?.optionsCut).toBe(true);
  });

  it("ノードの discarded: 破棄の判断が記録済みなら true（画面は、指示済みと出して、もう一度は出さない）", () => {
    const s = must(base());
    const v = uiViewOf({
      ...s,
      nodes: s.nodes.map((n) =>
        n.id === "a" ? { ...n, discarded: { seq: 1, at: AT, by: { human: true } } } : n,
      ),
    });
    expect(v.nodes.map((n) => [n.id, n.discarded])).toEqual([
      ["root", false],
      ["a", true],
    ]);
  });

  it("件数の上限を超えたら、切って、truncated に種類を入れる", () => {
    const items = Array.from({ length: UI_LIMITS.inbox + 5 }, (_, i) =>
      added(`p${i}`, "progress", "a"),
    );
    const v = uiViewOf(must([...base(), ...items]));
    expect(v.inbox).toHaveLength(UI_LIMITS.inbox);
    expect(v.truncated).toContain("inbox");
  });
});

describe("拡張要求の対象の表示", () => {
  const w = (value: unknown) => uiTargetOf({ kind: "write", value });
  const c = (value: unknown) => uiTargetOf({ kind: "command", value });

  it.each([
    "src/app.ts",
    "docs/設計 メモ.md",
    "packages/*/src/**/*.ts",
    "a..b/c",
    ".hidden/x",
    "src/a.ts:12",
  ])("write: 作業ツリー内の相対パス %j は、そのまま表示する", (v) => {
    expect(w(v)).toEqual({ kind: "write", target: v, targetHidden: false });
  });

  it.each([
    ["絶対パス", "/etc/passwd"],
    ["絶対パス（バックスラッシュ）", "\\Windows\\x"],
    ["ホーム", "~/.ssh/id_rsa"],
    ["ドライブ", "C:\\Users\\x"],
    ["ドライブ（スラッシュ）", "c:/x"],
    ["スキーム", "file:///etc/passwd"],
    [".. の区間", "../x"],
    [".. の区間（途中）", "src/../../x"],
    [".. の区間（バックスラッシュ）", "src\\..\\x"],
    [".. だけ", ".."],
    ["末尾の ..", "src/.."],
    ["改行", "src/a\nb"],
    ["タブ", "src/a\tb"],
    ["NUL", "src/a\u0000b"],
    ["DEL", "src/a\u007fb"],
    ["書式制御文字（U+202E）", "src/a\u202eb"],
    ["ゼロ幅", "src/a\u200bb"],
    ["空", ""],
    ["空白だけ", "   "],
    ["文字列でない", 5],
    ["長すぎる", "a".repeat(UI_TARGET_MAX + 1)],
  ])("write: %s は、値を出さずに隠す（切らない）", (_n, v) => {
    const r = w(v);
    expect(r).toEqual({ kind: "write", targetHidden: true });
    expect(JSON.stringify(r)).not.toContain(String(v).slice(0, 5) || "\u0000never");
  });

  it.each([" src/a.ts", "src/a.ts ", "\u3000src/a.ts"])(
    "write: 先頭か末尾に空白がある %j は隠す",
    (v) => {
      expect(w(v)).toEqual({ kind: "write", targetHidden: true });
    },
  );

  it("隠れていなければ、target は元の value と完全に同じ（切らない・整えない）。隠れていれば、値を持たない", () => {
    const alphabet = [
      "a",
      "1",
      ".",
      "/",
      " ",
      "-",
      "=",
      ",",
      ":",
      "~",
      "\\",
      "$",
      "{",
      "`",
      "\n",
      "\u202e",
      "あ",
      "'",
    ];
    // 長さ 0〜4 の全部の組み合わせ（網羅）。長さごとに、前の長さの語だけを伸ばす（全体を毎回なめない）
    const words = [""];
    let level = [""];
    for (let len = 0; len < 4; len++) {
      const next: string[] = [];
      for (const base of level) for (const ch of alphabet) next.push(base + ch);
      words.push(...next);
      level = next;
    }
    // 長いものは、擬似乱数（固定の種）で
    let seed = 12345;
    const rnd = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    for (let i = 0; i < 3000; i++) {
      let t = "";
      const n = 1 + Math.floor(rnd() * 30);
      for (let k = 0; k < n; k++) t += alphabet[Math.floor(rnd() * alphabet.length)];
      words.push(t);
    }
    // 判定は、件数が多い（語の数 × 2）ので、expect を 1 件ずつ呼ばずに、同じ条件を素の比較で確かめ、破れた入力を集めて最後に 1 回だけ比べる
    // （判定の条件は、以前の expect と同じ。expect の呼び出しの重さで、遅い CI の時間の上限を超えないため）
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字が残らないことの検査
    const CONTROL = /[\u0000-\u001f\u007f-\u009f\p{Cf}]/u;
    const DOTDOT = /(^|[\s=,:/\\])\.\.($|[\s,:/\\])/;
    const COMMAND = /^[A-Za-z0-9._:@%+=,/ -]+$/;
    const broken: { kind: string; value: string; why: string }[] = [];
    const note = (kind: string, value: string, why: string) => {
      if (broken.length < 20) broken.push({ kind, value, why });
    };
    let shown = 0;
    let checked = 0;
    for (const kind of ["write", "command"] as const) {
      for (const value of words) {
        checked++;
        const r = uiTargetOf({ kind, value });
        if (r.targetHidden) {
          const keys = Object.keys(r).sort().join(",");
          if (keys !== "kind,targetHidden" || r.kind !== kind || r.targetHidden !== true)
            note(kind, value, `隠したのに余計な値がある: ${JSON.stringify(r)}`);
        } else {
          shown++;
          if (r.target !== value)
            note(kind, value, `target が元の値と違う: ${JSON.stringify(r.target)}`);
          if (value !== value.trim()) note(kind, value, "前後に空白がある");
          if (CONTROL.test(value)) note(kind, value, "制御文字・書式制御文字がある");
          if (DOTDOT.test(value)) note(kind, value, ".. の区間がある");
          if (kind === "command" && !COMMAND.test(value))
            note(kind, value, "コマンドに使えない文字がある");
        }
      }
    }
    expect(broken).toEqual([]);
    expect(checked).toBe(words.length * 2); // すべての入力を確かめた
    expect(shown).toBeGreaterThan(1000); // 表示される値も、十分に試している
  });

  it("上限ちょうどは表示する。1 つ超えたら隠す（切った値を承認させない）", () => {
    expect(w("a".repeat(UI_TARGET_MAX))).toMatchObject({ targetHidden: false });
    expect(w("a".repeat(UI_TARGET_MAX + 1))).toEqual({ kind: "write", targetHidden: true });
    // コードポイントで数える
    expect(w("あ".repeat(UI_TARGET_MAX))).toMatchObject({ targetHidden: false });
  });

  it.each([
    "pnpm test",
    "git diff --stat src/a.ts",
    "node scripts/x.mjs --flag=a/b",
    "gcc -Isrc/inc a.c",
    "ls a/b",
    "tool --list=a,b:c@1.0%+",
  ])("command: 許可リストに合い、絶対パスも .. もない %j は、そのまま表示する", (v) => {
    expect(c(v)).toEqual({ kind: "command", target: v, targetHidden: false });
  });

  it.each([
    ["先頭が絶対パス", "/usr/bin/rm -rf x"],
    ["引数が絶対パス", "cat /etc/passwd"],
    ["= のあとが絶対パス", "tool --out=/tmp/x"],
    ["引用符のあとが絶対パス", `sh -c "cat /etc/passwd"`],
    ["リダイレクト先が絶対パス", "echo x >/tmp/x"],
    ["リダイレクト（許可リスト外）", "ls a/b > out.txt"],
    ["短いオプションに続く絶対パス（tar -I/usr/lib）", "tar -I/usr/lib x"],
    ["先頭の短いオプション + /", "-I/usr/lib"],
    ["ブレース展開", "cat {/etc,x}"],
    [", のあとが絶対パス", "cat a,/etc/passwd"],
    ["環境変数", "cat $HOME/x"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 環境変数の記法の試験
    ["環境変数（波括弧）", "cat ${HOME}/x"],
    ["バッククォート", "echo `id`"],
    ["コマンド置換", "echo $(id)"],
    ["パイプ", "ls | sh"],
    ["バックスラッシュ", "dir a\\b"],
    ["引用符", "echo 'x'"],
    ["ワイルドカードの *", "rm *"],
    ["先頭の空白", " pnpm test"],
    ["末尾の空白", "pnpm test "],
    ["; のあとが絶対パス", "echo x;/bin/sh"],
    ["ホーム", "cat ~/.bashrc"],
    ["ドライブ", "type C:\\x"],
    [".. の区間", "cat ../x"],
    [".. の区間（途中）", "cat a/../../x"],
    ["= のあとが ..", "tool --dir=../x"],
    ["改行", "pnpm test\nrm -rf x"],
    ["制御文字", "pnpm\u0007test"],
    ["書式制御文字", "pnpm test\u202e"],
    ["長すぎる", "a ".repeat(UI_TARGET_MAX)],
  ])("command: %s は隠す", (_n, v) => {
    expect(c(v)).toEqual({ kind: "command", targetHidden: true });
  });

  it("種類が write でも command でもない・target がない・オブジェクトでない場合は、種類も出さずに隠す", () => {
    for (const t of [undefined, null, 5, "x", {}, { kind: "read", value: "a" }]) {
      expect(uiTargetOf(t)).toEqual({ targetHidden: true });
    }
  });

  it("uiViewOf: 拡張要求に、対象（kind・target）を載せる。隠れた対象は値を出さず、targetHidden", () => {
    const s = must([
      ...base(),
      ev({
        type: "node.stateChanged",
        payload: { nodeId: "a", event: { type: "start" } },
      } as never),
      ev({
        type: "scope.extensionRequested",
        payload: {
          extensionId: "x1",
          nodeId: "a",
          target: { kind: "write", value: "src/ok.ts" },
          reason: "足りない",
        },
      } as never),
      ev({
        type: "scope.extensionRequested",
        payload: {
          extensionId: "x2",
          nodeId: "a",
          target: { kind: "write", value: "../outside" },
          reason: "外",
        },
      } as never),
    ]);
    const v = uiViewOf(s);
    expect(v.extensions).toEqual([
      {
        id: "x1",
        nodeId: "a",
        reason: "足りない",
        kind: "write",
        target: "src/ok.ts",
        targetHidden: false,
        at: AT,
      },
      { id: "x2", nodeId: "a", reason: "外", kind: "write", targetHidden: true, at: AT },
    ]);
    expect(JSON.stringify(v)).not.toContain("outside");
  });

  it("件数の上限: 拡張要求は UI_LIMITS.extensions まで。切ったら truncated に extensions", () => {
    const evs = base();
    // 1 ノードの未判定の上限があるので、複数のノードに分ける
    const ids: string[] = [];
    for (let i = 0; i < UI_LIMITS.extensions + 1; i++) {
      const id = `n${i}`;
      ids.push(id);
      evs.push(created(id, "implement", "root"));
      evs.push(
        ev({
          type: "node.stateChanged",
          payload: { nodeId: id, event: { type: "start" } },
        } as never),
      );
      evs.push(
        ev({
          type: "scope.extensionRequested",
          payload: {
            extensionId: `x${i}`,
            nodeId: id,
            target: { kind: "write", value: "a" },
            reason: "r",
          },
        } as never),
      );
    }
    const v = uiViewOf(must(evs));
    expect(v.extensions).toHaveLength(UI_LIMITS.extensions);
    expect(v.truncated).toContain("extensions");
  });

  it("閉じた判断（破棄を決めた子）も、理由つきで返す", () => {
    const s = must(base());
    const withClosed: OrchState = {
      ...s,
      decisions: [
        {
          decisionId: "d1",
          nodeId: "a",
          status: "open",
          question: "どれ？",
          options: ["A"],
          rejected: [],
        } as never,
        {
          decisionId: "d2",
          nodeId: "a",
          status: "closed",
          closedReason: "discarded",
          question: "閉じた質問",
          rejected: [],
        } as never,
      ],
    };
    const v = uiViewOf(withClosed);
    expect(v.decisions.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(v.decisions.find((d) => d.id === "d1")?.closedReason).toBeUndefined();
    expect(v.decisions.find((d) => d.id === "d2")?.closedReason).toBe("discarded");
  });
});

describe("uiViewOf の #89 の値（題・最後の動き・人の要対応・段・やり取り）", () => {
  const start = (id: string) =>
    ev({ type: "node.stateChanged", payload: { nodeId: id, event: { type: "start" } } } as never);
  const report = (id: string, nodeId: string, kind: string, at = AT, text = "t") =>
    ev({ type: "report.added", payload: { reportId: id, nodeId, kind, text } } as never, at);

  it("題は目的の先頭を整えて UI_TITLE_MAX で切る。受け入れ基準は載せない。目的がなければ題はない", () => {
    const long = `${"あ".repeat(UI_TITLE_MAX + 5)}`;
    const s = must([
      ...base(),
      created("b", "implement", "root", {
        objective: "  集計を\n\t直す   こと  ",
        acceptanceCriteria: ["秘密の基準"],
        scope: { writableLocations: ["src"], forbiddenLocations: [".git"], allowedCommands: [] },
      }),
      created("c", "implement", "root", {
        objective: long,
        acceptanceCriteria: ["c"],
        scope: { writableLocations: ["src"], forbiddenLocations: [".git"], allowedCommands: [] },
      }),
    ]);
    const v = uiViewOf(s);
    expect(v.nodes.find((x) => x.id === "b")?.title).toBe("集計を 直す こと");
    expect(v.nodes.find((x) => x.id === "c")?.title).toBe(
      `${"あ".repeat(UI_TITLE_MAX)}${UI_CUT_MARK}`,
    );
    expect(v.nodes.find((x) => x.id === "a")).not.toHaveProperty("title");
    expect(JSON.stringify(v)).not.toContain("秘密の基準");
  });

  it("最後の動きは、報告・受信箱・判断の要求のうち、いちばん新しい時刻。記録がなければない", () => {
    const s = must([
      ...base(),
      start("a"),
      report("r1", "a", "progress", "2026-10-20T01:00:00Z"),
      added("i1", "info", "a", { summary: "x" }),
      ev(
        {
          type: "decision.requested",
          payload: { decisionId: "d1", nodeId: "a", question: "q" },
        } as never,
        "2026-10-20T02:00:00Z",
      ),
    ]);
    const v = uiViewOf(s);
    expect(v.nodes.find((x) => x.id === "a")?.lastActivityAt).toBe("2026-10-20T02:00:00Z");
    expect(v.nodes.find((x) => x.id === "root")).not.toHaveProperty("lastActivityAt");
  });

  it("人の要対応は、未回答の判断・未判定の拡張・止まっているかも・停止未完了だけを数える（進み具合・完了・知らせは数えない）", () => {
    const s = must([
      ...base(),
      start("a"),
      added("p1", "progress", "a", { summary: "進んだ" }),
      added("i1", "info", "a", { summary: "ふつうの知らせ" }),
      added("s1", "info", "a", { summary: stallSummary("a", 25) }),
      ev({
        type: "decision.requested",
        payload: { decisionId: "d1", nodeId: "a", question: "q" },
      } as never),
      ev({
        type: "scope.extensionRequested",
        payload: {
          extensionId: "x1",
          nodeId: "a",
          target: { kind: "write", value: "src/x.ts" },
          reason: "r",
        },
      } as never),
    ]);
    const v = uiViewOf(s);
    const a = v.nodes.find((x) => x.id === "a");
    expect(a?.openItems).toBe(3);
    expect(a?.needsHuman).toBe(3);
    expect(a?.band).toBe("turn");
    expect(v.inbox.find((x) => x.id === "s1")?.stall).toBe(true);
    expect(v.inbox.find((x) => x.id === "i1")).not.toHaveProperty("stall");
    expect(isStallSummary(stallSummary("a", 25))).toBe(true);
    expect(isStallSummary("子 a は元気")).toBe(false);
  });

  it("段: 人の要対応がなければ、動いている子は running、受理・停止は finished", () => {
    const s = must([...base(), start("a"), created("b", "implement", "root")]);
    const v = uiViewOf(s);
    expect(v.nodes.find((x) => x.id === "a")?.band).toBe("running");
    expect(v.nodes.find((x) => x.id === "a")?.needsHuman).toBe(0);
  });

  it("受信箱の項目に、識別子の形の ref だけを載せる", () => {
    const s = must([
      ...base(),
      start("a"),
      ev({
        type: "scope.extensionRequested",
        payload: {
          extensionId: "x1",
          nodeId: "a",
          target: { kind: "write", value: "src/x.ts" },
          reason: "r",
        },
      } as never),
      added("v1", "violation", "a", { summary: "x", ref: "x1" }),
    ]);
    expect(uiViewOf(s).inbox.find((x) => x.id === "v1")?.ref).toBe("x1");
  });

  it("やり取り: 画面のほかの所で、いま見える・かつて見えた文（報告・判断の問い・範囲の頼みの理由）だけ、短い本文（text。上限 UI_FLOW_TEXT_MAX）を載せる。指示・答えの文は載せない", () => {
    const long = "長".repeat(UI_FLOW_TEXT_MAX + 50);
    const evs = [
      ...base(),
      start("a"),
      report("r1", "a", "progress", "2026-10-20T03:00:00Z", long),
      ev({
        type: "decision.requested",
        payload: { decisionId: "d1", nodeId: "a", question: "どちらにしますか" },
      } as never),
      ev({
        type: "scope.extensionRequested",
        payload: {
          extensionId: "x1",
          nodeId: "a",
          target: { kind: "write", value: "src/x.ts" },
          reason: "テストを足したい",
        },
      } as never),
      ev({ type: "node.instructed", payload: { nodeId: "a", text: "秘密の指示" } } as never),
    ];
    const v = uiViewOf(must(evs));
    const of = (k: string) => v.flows.find((f) => f.kind === k);
    expect(of("decision")?.text).toBe("どちらにしますか");
    expect(of("extension")?.text).toBe("テストを足したい");
    const r = of("report")?.text ?? "";
    expect(Array.from(r).length).toBe(UI_FLOW_TEXT_MAX + Array.from(UI_CUT_MARK).length);
    expect(r.endsWith(UI_CUT_MARK)).toBe(true);
    expect(of("instruction")?.text).toBeUndefined();
    expect(JSON.stringify(v.flows)).not.toContain("秘密の指示");
  });

  it("やり取り: 指示は sent → delivered → done（推定）。本文は載せない", () => {
    const evs = [
      ...base(),
      start("a"),
      ev({ type: "node.instructed", payload: { nodeId: "a", text: "秘密の本文" } } as never),
    ];
    const seq = evs.length;
    const sent = uiViewOf(must(evs)).flows.find((f) => f.kind === "instruction");
    expect(sent).toMatchObject({ dir: "down", from: "human", to: "a", stage: "sent", sentAt: AT });
    const delivered = [
      ...evs,
      ev({ type: "node.instructionDelivered", payload: { instructedSeq: seq } } as never),
    ];
    expect(uiViewOf(must(delivered)).flows.find((f) => f.kind === "instruction")?.stage).toBe(
      "delivered",
    );
    const done = [...delivered, report("r1", "a", "progress", "2026-10-20T03:00:00Z")];
    const v = uiViewOf(must(done));
    expect(v.flows.find((f) => f.kind === "instruction")).toMatchObject({
      stage: "done",
      doneInferred: true,
      doneAt: "2026-10-20T03:00:00Z",
    });
    expect(JSON.stringify(v)).not.toContain("秘密の本文");
  });

  it("やり取り: daemon が種類を付けた追加指示は、許可・却下・切り出し。答えは重ねない。文の頭では見分けない（#115）", () => {
    const ins = (text: string, kind?: string) =>
      ev({
        type: "node.instructed",
        payload: { nodeId: "a", text, ...(kind === undefined ? {} : { kind }) },
      } as never);
    const evs = [
      ...base(),
      start("a"),
      ins("x", "extensionRejected"),
      ins("x", "extensionApproved"),
      ins("x", "extensionSplit"),
      ins("答え", "answer"),
      // 種類のない指示は、文の頭が daemon の文と同じでも、ふつうの指示（親・人が書けるため）
      ins("【人間からの回答】判断 d1"),
      ins("範囲の拡張の要求（コマンド ls）は承認された。使ってよい"),
    ];
    const kinds = uiViewOf(must(evs))
      .flows.filter((f) => f.dir === "down")
      .map((f) => f.kind);
    expect(kinds.sort()).toEqual(["approved", "instruction", "instruction", "rejected", "split"]);
  });

  it("追加指示の種類が知らないものなら、記録を拒む", () => {
    const r = foldEvents([
      ...base(),
      start("a"),
      ev({ type: "node.instructed", payload: { nodeId: "a", text: "x", kind: "other" } } as never),
    ]);
    expect(r.ok).toBe(false);
  });

  it("やり取り: 子 → 親は届いたかは分からない。判断の頼みは答えで done、答えは子の次の報告で done（推定）", () => {
    const evs = [
      ...base(),
      start("a"),
      ev({
        type: "decision.requested",
        payload: { decisionId: "d1", nodeId: "a", question: "q" },
      } as never),
    ];
    const open = uiViewOf(must(evs)).flows.find((f) => f.kind === "decision");
    expect(open).toMatchObject({
      dir: "up",
      from: "a",
      to: "root",
      stage: "sent",
      deliveryUnknown: true,
    });
    const answered = [
      ...evs,
      ev(
        { type: "decision.answered", payload: { decisionId: "d1", answer: "日" } } as never,
        "2026-10-20T04:00:00Z",
      ),
    ];
    const v = uiViewOf(must(answered));
    expect(v.flows.find((f) => f.kind === "decision")).toMatchObject({
      stage: "done",
      doneAt: "2026-10-20T04:00:00Z",
    });
    expect(v.flows.find((f) => f.kind === "answer")).toMatchObject({
      dir: "down",
      to: "a",
      stage: "sent",
      deliveryUnknown: true,
    });
    expect(v.flows[0]?.kind).toBe("answer");
    const replied = uiViewOf(
      must([...answered, report("r1", "a", "progress", "2026-10-20T05:00:00Z")]),
    );
    expect(replied.flows.find((f) => f.kind === "answer")).toMatchObject({
      stage: "done",
      doneInferred: true,
    });
    expect(replied.flows.find((f) => f.kind === "report")).toMatchObject({
      stage: "done",
      deliveryUnknown: true,
    });
  });

  it("やり取り: 完了の報告は受理の前は sent、拡張の頼みは判定で done", () => {
    const s = must([
      ...base(),
      start("a"),
      ev({
        type: "scope.extensionRequested",
        payload: {
          extensionId: "x1",
          nodeId: "a",
          target: { kind: "write", value: "src/x.ts" },
          reason: "r",
        },
      } as never),
      ev(
        {
          type: "scope.extensionDecided",
          payload: { extensionId: "x1", decision: "reject" },
        } as never,
        "2026-10-20T06:00:00Z",
      ),
      report("r1", "a", "done"),
      ev({
        type: "node.stateChanged",
        payload: { nodeId: "a", event: { type: "reportDone" } },
      } as never),
    ]);
    const v = uiViewOf(s);
    expect(v.flows.find((f) => f.kind === "extension")).toMatchObject({
      stage: "done",
      doneAt: "2026-10-20T06:00:00Z",
    });
    expect(v.flows.find((f) => f.kind === "done")).toMatchObject({ stage: "sent", to: "root" });
  });

  it("やり取り: 完了の報告は、受理・差し戻しのあと done で、doneAt はその時刻", () => {
    const s = must([
      ...base(),
      start("a"),
      report("r1", "a", "done"),
      ev({
        type: "node.stateChanged",
        payload: { nodeId: "a", event: { type: "reportDone" } },
      } as never),
      ev(
        { type: "node.stateChanged", payload: { nodeId: "a", event: { type: "accept" } } } as never,
        "2026-10-20T07:00:00Z",
      ),
    ]);
    expect(uiViewOf(s).flows.find((f) => f.kind === "done")).toMatchObject({
      stage: "done",
      doneAt: "2026-10-20T07:00:00Z",
    });
  });

  it("やり取りは UI_LIMITS.flows 件まで。切ったら truncated に flows", () => {
    const evs = [...base(), start("a"), created("b", "implement", "root"), start("b")];
    for (let i = 0; i < UI_LIMITS.flows + 1; i++)
      evs.push(report(`r${i}`, i % 2 === 0 ? "a" : "b", "progress"));
    const v = uiViewOf(must(evs));
    expect(v.flows).toHaveLength(UI_LIMITS.flows);
    expect(v.truncated).toContain("flows");
  });
});
