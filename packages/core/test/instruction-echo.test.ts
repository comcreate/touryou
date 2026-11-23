import { describe, expect, it } from "vitest";
import { instructionEcho } from "../src/echo.js";
import {
  ECHO_LENGTH,
  type EventBody,
  foldEvents,
  inboxMessage,
  inboxMessageText,
  isEchoShape,
  judgeEcho,
  normalizeInstructionText,
  type OrchEvent,
  unquoteInstructionText,
} from "../src/index.js";

describe("指示の復唱（#261）: 正規化", () => {
  it("改行を LF にそろえ、各行の末尾の空白と本文の末尾の空行を除く。行頭の空白は残す", () => {
    expect(normalizeInstructionText("a  \r\nb\t\rc d e\n\n")).toBe("a\nb\nc\nd\ne");
    expect(normalizeInstructionText("  字下げ\n    もっと")).toBe("  字下げ\n    もっと");
    expect(normalizeInstructionText("")).toBe("");
  });

  it("改行の種類・末尾の空白だけが違う文は、同じ復唱になる。中身が違えば違う復唱になる", () => {
    expect(instructionEcho("a\r\nb  ")).toBe(instructionEcho("a\nb"));
    expect(instructionEcho("a\nb")).not.toBe(instructionEcho("a\nc"));
    expect(instructionEcho(" a")).not.toBe(instructionEcho("a"));
  });
});

describe("指示の復唱（#261）: ハッシュ値", () => {
  it("SHA-256 の先頭 16 桁（小文字の 16 進数）。決定的で、本文そのものは含まない", () => {
    // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(instructionEcho("abc")).toBe("ba7816bf8f01cfea");
    expect(instructionEcho("abc")).toHaveLength(ECHO_LENGTH);
    expect(isEchoShape(instructionEcho("秘密のトークン tk-123"))).toBe(true);
    expect(instructionEcho("秘密のトークン tk-123")).not.toContain("tk-123");
  });

  it("isEchoShape: 小文字の 16 進数 16 桁だけ", () => {
    for (const bad of [
      "",
      "ba7816bf8f01cfe",
      "ba7816bf8f01cfea0",
      "BA7816BF8F01CFEA",
      "zz7816bf8f01cfea",
      1,
      null,
    ]) {
      expect(isEchoShape(bad), String(bad)).toBe(false);
    }
    expect(isEchoShape("ba7816bf8f01cfea")).toBe(true);
  });
});

describe("指示の復唱（#261）: 照合（純粋関数）", () => {
  const expected = instructionEcho("x を直す");

  it("一致・食い違い・復唱なしを分ける。同じ入力には、いつも同じ答え（再送しても冪等）", () => {
    expect(judgeEcho(expected, expected)).toBe("match");
    expect(judgeEcho(expected, instructionEcho("y を直す"))).toBe("mismatch");
    expect(judgeEcho(expected, undefined)).toBe("missing");
    expect(judgeEcho(expected, expected)).toBe(judgeEcho(expected, expected));
  });
});

describe("指示の復唱（#261）: 引用の外し", () => {
  it("頭の `> ` を 1 つだけ外す。行頭の空白・`>` で始まる元の文は残す", () => {
    expect(unquoteInstructionText("> a\n> \n>   b\n> > c")).toBe("a\n\n  b\n> c");
  });
});

describe("指示の復唱（#261）: 配送の記録の echo", () => {
  const SYS = { system: true } as const;
  let n = 0;
  const ev = (body: EventBody): OrchEvent =>
    ({
      seq: ++n,
      at: "2026-11-24T00:00:00Z",
      requestId: `r${n}`,
      actor: SYS,
      ...body,
    }) as OrchEvent;
  const base = (): OrchEvent[] => {
    n = 0;
    return [
      ev({
        type: "node.created",
        payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
      } as never),
      ev({
        type: "node.stateChanged",
        payload: { nodeId: "root", event: { type: "start" } },
      } as never),
      ev({ type: "node.instructed", payload: { nodeId: "root", text: "x" } } as never),
    ];
  };
  const fold = (extra: EventBody) => foldEvents([...base(), ev(extra)]);

  it("echo は配送の記録と一緒に、指示の記録に載る。ない記録は復唱なし（古い記録・古い MCP）", () => {
    const echo = instructionEcho("x");
    const withEcho = fold({
      type: "node.instructionDelivered",
      payload: { instructedSeq: 3, echo },
    });
    expect(withEcho.ok && withEcho.value.instructions[0]).toMatchObject({ deliveredSeq: 4, echo });
    const without = fold({ type: "node.instructionDelivered", payload: { instructedSeq: 3 } });
    expect(without.ok && without.value.instructions[0]?.echo).toBeUndefined();
    expect(without.ok && without.value.instructions[0]?.deliveredSeq).toBe(4);
  });

  it("形の合わない echo は、記録を拒む。二度目の配送の記録は、最初の記録（echo を含む）を残す", () => {
    const bad = fold({
      type: "node.instructionDelivered",
      payload: { instructedSeq: 3, echo: "短い" },
    });
    expect(bad.ok).toBe(false);
    const echo = instructionEcho("x");
    const twice = foldEvents([
      ...base(),
      ev({ type: "node.instructionDelivered", payload: { instructedSeq: 3, echo } }),
      ev({
        type: "node.instructionDelivered",
        payload: { instructedSeq: 3, echo: instructionEcho("y") },
      }),
    ]);
    expect(twice.ok && twice.value.instructions[0]?.echo).toBe(echo);
  });
});

describe("指示の復唱（#261）: 知らせの文", () => {
  const long = `node-${"0".repeat(32)}`;

  it("食い違い・復唱が返らない: 実際の長さのノード ID でも、要約は上限に収まる。内部の道具名・ハッシュ値を出さない", () => {
    for (const [key, args] of [
      ["echoMismatch", { node: long, seq: 123456 }],
      ["echoMissing", { node: long, seq: 123456, minutes: 1440 }],
    ] as const) {
      const m = inboxMessage(key, args);
      expect([...m.summary].length, key).toBeLessThanOrEqual(200);
      // 「次にすること」は AI 向けなので node_send・tree_list は書く。受け取りの内部の名前・ハッシュ値は出さない
      for (const word of [
        "child_bind",
        "child.inbox",
        "ackThrough",
        "echoes",
        "sha",
      ]) {
        expect(m.summary, `${key} ${word}`).not.toContain(word);
      }
    }
  });

  it("次にすること・古い版の子への手・復唱の説明（一度だけ）が、日英の両方にある", () => {
    for (const lang of ["ja", "en"] as const) {
      const mismatch =
        inboxMessageText(lang, inboxMessage("echoMismatch", { node: "a", seq: 1 }).msg) ?? "";
      const missing =
        inboxMessageText(lang, inboxMessage("echoMissing", { node: "a", seq: 1, minutes: 5 }).msg) ??
        "";
      expect(mismatch, lang).toContain("node_send");
      expect(missing, lang).toContain("tree_list");
      expect(missing, lang).toContain("plugin");
      // 「復唱」（英語は echo）の言葉は、1 つの文に一度だけ
      const word = lang === "ja" ? "復唱" : "echo";
      for (const s of [mismatch, missing]) expect(s.split(word), `${lang} ${s}`).toHaveLength(2);
    }
  });
});
