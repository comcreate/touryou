import { describe, expect, it } from "vitest";
import { graphModelOf } from "../../src/ui/graph-model.js";
import { graphString } from "../../src/ui/graph-text.js";
import { UI_TEXT } from "../../src/ui/i18n.js";

// #168 PR6: 関係図のサブ統括（根でない統合ノード）の表示

const node = (
  id: string,
  parentId: string | null,
  role: string,
  band: string,
  state: string,
  extra: Record<string, unknown> = {},
) => ({ id, parentId, role, state, band, title: id, ...extra });
const roleOf = (m: { nodes: readonly { id: string; role: string }[] }, id: string) =>
  m.nodes.find((x) => x.id === id)?.role;

describe("関係図: サブ統括の配下の数（#168）", () => {
  // root ─ sub（サブ統括。配下 3 件・うち答え待ち 1 件）─ g1（動いている）
  //                                                  ├ g2（済んだ）
  //                                                  └ g3（済んだ）
  const view = {
    nodes: [
      node("root", null, "integrator", "running", "running"),
      node("sub", "root", "integrator", "running", "running", {
        below: { count: 3, needsHuman: 1 },
      }),
      node("g1", "sub", "implement", "running", "running"),
      node("g2", "sub", "implement", "finished", "verified"),
      node("g3", "sub", "implement", "finished", "stopped"),
    ],
    flows: [],
  };

  it("サブ統括の役割の名前に、配下の件数と答え待ちの件数を添える（日本語・英語）", () => {
    expect(roleOf(graphModelOf(view, "ja"), "sub")).toBe("統合（配下 3 件・あなたの答え 1 件）");
    expect(roleOf(graphModelOf(view, "en"), "sub")).toBe("integrator (3 below, 1 awaiting you)");
  });

  it("答え待ちがなければ、件数だけ", () => {
    const quiet = {
      ...view,
      nodes: view.nodes.map((x) =>
        x.id === "sub" ? { ...x, below: { count: 2, needsHuman: 0 } } : x,
      ),
    };
    expect(roleOf(graphModelOf(quiet, "ja"), "sub")).toBe("統合（配下 2 件）");
    expect(roleOf(graphModelOf(quiet, "en"), "sub")).toBe("integrator (2 below)");
  });

  it("根・作業ノードには添えない。根に below があっても無視する（サブ統括だけの表示）", () => {
    const m = graphModelOf(
      {
        ...view,
        nodes: view.nodes.map((x) =>
          x.id === "root" || x.id === "g1" ? { ...x, below: { count: 9, needsHuman: 9 } } : x,
        ),
      },
      "ja",
    );
    expect(roleOf(m, "root")).toBe("統合");
    expect(roleOf(m, "g1")).toBe("作業");
  });

  it("形の崩れた below は、添えずに無視する（数でない・負・巨大）", () => {
    for (const below of ["x", null, [], { count: "a", needsHuman: -1 }]) {
      const m = graphModelOf(
        { ...view, nodes: view.nodes.map((x) => (x.id === "sub" ? { ...x, below } : x)) },
        "ja",
      );
      const role = roleOf(m, "sub") ?? "";
      expect(role.startsWith("統合")).toBe(true);
      expect(role).not.toContain("-1");
    }
    const big = graphModelOf(
      {
        ...view,
        nodes: view.nodes.map((x) =>
          x.id === "sub" ? { ...x, below: { count: 1e9, needsHuman: 1e9 } } : x,
        ),
      },
      "ja",
    );
    expect(roleOf(big, "sub")).toBe("統合（配下 999 件・あなたの答え 999 件）");
  });

  it("止めた・済んだ子を隠す（#206）は、サブ統括の下にも効く。件数は core が数えたまま（隠しても変わらない）", () => {
    const m = graphModelOf(view, "ja", { hideFinished: true });
    expect(m.nodes.map((x) => x.id)).toEqual(["root", "sub", "g1"]);
    expect(m.hidden).toBe(2);
    expect(roleOf(m, "sub")).toBe("統合（配下 3 件・あなたの答え 1 件）");
  });

  it("サブ統括ごとに隠す: 別のサブ統括の下の済んだ子も、それぞれ隠す", () => {
    const two = {
      nodes: [
        node("root", null, "integrator", "running", "running"),
        node("s1", "root", "integrator", "running", "running", {
          below: { count: 2, needsHuman: 0 },
        }),
        node("s1a", "s1", "implement", "running", "running"),
        node("s1b", "s1", "implement", "finished", "verified"),
        node("s2", "root", "integrator", "running", "running", {
          below: { count: 2, needsHuman: 0 },
        }),
        node("s2a", "s2", "implement", "finished", "stopped"),
        node("s2b", "s2", "implement", "finished", "verified"),
      ],
      flows: [],
    };
    const m = graphModelOf(two, "ja", { hideFinished: true });
    expect(m.nodes.map((x) => x.id)).toEqual(["root", "s1", "s1a", "s2"]);
    expect(m.hidden).toBe(3);
  });

  it("文は、日本語・英語の両方に鍵がある", () => {
    for (const lang of ["ja", "en"] as const) {
      expect(graphString(lang, "role.below", { role: "R", n: 4, h: 0 })).toContain("4");
      expect(graphString(lang, "role.belowHuman", { role: "R", n: 4, h: 2 })).toContain("2");
    }
    expect(UI_TEXT["role.below"]).toEqual({
      ja: "{role}（配下 {n} 件）",
      en: "{role} ({n} below)",
    });
  });

  it("受信箱の要約（digest）の種類の名前は、サブ統括の要約（日本語・英語）", () => {
    expect(UI_TEXT["kind.digest"]).toEqual({
      ja: "サブ統括の要約",
      en: "sub-integrator summary",
    });
  });
});
