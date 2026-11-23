import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { failureMsg, HUMAN_RESOLVABLE_KINDS } from "@touryou/core";
import { describe, expect, it } from "vitest";
import {
  FAILURES_JSON,
  INBOX_MESSAGES_JSON,
  LIST_SEPS_JSON,
  UI_CSS,
  UI_HEADERS,
  UI_HTML,
  UI_HTML_HEADERS,
  UI_JS,
  UI_TEXT_JSON,
} from "../../src/api/ui-assets.js";
import { UI_GRAPH_JS } from "../../src/api/ui-graph-js.js";
import { EXTERNAL_CHECK_SUMMARY, externalCheckSummaries } from "../../src/external-check.js";
import { UI_TEXT as UI_TEXT_TABLE } from "../../src/ui/i18n.js";

/** 埋め込んだ文字の表の行（#140）。JSON のオブジェクトの値だけの行（行の終わりまで形を決める）。走査から除くのは、この行だけ。 */
const TABLE_LINE = /^ {2}var (?:TEXT|MESSAGES|SEPS|FAILURES) = \{[^\n]*\};$/gm;
const TABLE_LINE_ONE = /^ {2}var (?:TEXT|MESSAGES|SEPS|FAILURES) = /;

/** 画面の資産の走査。XSS・トークンの漏れにつながる書き方を禁じる。 */
describe("画面の資産（走査）", () => {
  const FORBIDDEN: readonly [string, RegExp][] = [
    ["innerHTML", /innerHTML/],
    ["outerHTML", /outerHTML/],
    ["insertAdjacentHTML", /insertAdjacentHTML/],
    ["document.write", /document\s*\.\s*write/],
    ["eval", /\beval\s*\(/],
    ["new Function", /new\s+Function\b|\bFunction\s*\(/],
    ["setAttribute", /setAttribute/],
    ["setAttributeNS・attributes", /setAttributeNS|\.attributes\b/],
    ["on* への代入", /\.on[a-z]+\s*=[^=]/],
    [
      "location への代入",
      /\blocation\s*(\.\s*(href|pathname|search|hash|protocol|host|hostname|port)\s*)?=[^=]/,
    ],
    ["location.assign・replace", /location\s*\.\s*(assign|replace)\s*\(/],
    ["srcdoc", /srcdoc/],
    ["文字列の setTimeout・setInterval", /set(Timeout|Interval)\s*\(\s*['"`]/],
    // localStorage だけは、設定（動きを止める・明暗・言語）を残すために、1 か所で狭く許す（#139。下の「localStorage の使い所」の試験）。
    // トークン・チケットを残さないこと、ほかの保存先を使わないことは、そのまま守る
    ["sessionStorage・cookie・indexedDB", /sessionStorage|document\s*\.\s*cookie|indexedDB/],
    ["importScripts・動的 import", /importScripts|\bimport\s*\(/],
    ["postMessage・window.open", /postMessage|window\s*\.\s*open/],
    ["ブラケット記法の文字列キー（メンバーの参照）", /[\w$)\]]\s*\[\s*['"`]/],
    [
      "HTML を解釈する API",
      /setHTMLUnsafe|parseHTMLUnsafe|setHTML\b|createContextualFragment|DOMParser|document\s*\.\s*createRange/,
    ],
    ["href・src・action・formAction への代入", /\.(href|src|action|formAction)\s*=[^=]/],
    [
      "危ないタグの生成",
      /createElement\s*\(\s*['"`](script|iframe|a|img|link|object|embed|form|base|meta|style|svg|math)['"`]/i,
    ],
    [
      "危ないタグを el に渡す",
      /\bel\s*\(\s*['"`](script|iframe|a|img|link|object|embed|form|base|meta|style|svg|math)['"`]/i,
    ],
  ];
  for (const [name, re] of FORBIDDEN) {
    it(`app.js に ${name} を使わない`, () => {
      expect(re.test(UI_JS), name).toBe(false);
    });
  }

  describe("localStorage の使い所（#139。設定を残すためだけに、狭く許す）", () => {
    const fnOf = (name: string): string => {
      const at = UI_JS.indexOf(`function ${name}(`);
      expect(at, name).toBeGreaterThan(0);
      const end = UI_JS.indexOf("\n  }\n", at);
      return UI_JS.slice(at, end);
    };
    it("使うのは loadSettings・saveSettings の中だけ。鍵は touryou.ui.settings の 1 つだけ", () => {
      const uses = UI_JS.match(/window\.localStorage\b/g) ?? [];
      expect(uses).toHaveLength(2);
      expect(fnOf("loadSettings")).toContain("window.localStorage.getItem(SETTINGS_KEY)");
      expect(fnOf("saveSettings")).toContain("window.localStorage.setItem(SETTINGS_KEY,");
      // localStorage の名前は、ほかで参照しない（window の外の別名・ブラケット記法も含めて）
      const rest = UI_JS.replace(fnOf("loadSettings"), "").replace(fnOf("saveSettings"), "");
      expect(rest.replace(/\/\/[^\n]*/g, "")).not.toMatch(/localStorage/);
      expect(UI_JS.match(/var SETTINGS_KEY = '([^']*)'/)?.[1]).toBe("touryou.ui.settings");
      expect(UI_JS.match(/localStorage\.(getItem|setItem|removeItem|clear)\(/g)?.length).toBe(2);
    });
    it("書く値は still・theme・lang・hideFinished だけ（形を確かめた値）", () => {
      const save = fnOf("saveSettings");
      expect(save).toContain("var v = settingsOf(x);");
      expect(save).toContain(
        "JSON.stringify({ still: v.still, theme: v.theme, lang: v.lang, hideFinished: v.hideFinished })",
      );
    });
    it("読み出した値は形を確かめ、知らない鍵・形の違う値は捨てる", () => {
      const src = fnOf("settingsOf");
      // 覚えた言語がなければ、ブラウザの言語（#140）
      const of = (language: string) =>
        runInNewContext(
          `${fnOf("browserLang")}\n  }\n(${src.replace("function settingsOf(", "function (")}\n  })`,
          { navigator: { language } },
        ) as (o: unknown) => unknown;
      const settingsOf = of("ja-JP");
      // 言語は、選んだときだけ残す（選んでいなければ undefined で、JSON に書かれない。#140）
      // 止めた・済んだ子を隠すのは、true を覚えているときだけ（既定は出す。#206）
      expect(settingsOf(null)).toEqual({
        still: false,
        theme: "auto",
        lang: undefined,
        hideFinished: false,
      });
      expect(of("en-US")({ lang: "ja" })).toEqual({
        still: false,
        theme: "auto",
        lang: "ja",
        hideFinished: false,
      });
      expect(
        settingsOf({ still: "yes", theme: "neon", lang: "fr", hideFinished: "yes", token: "t" }),
      ).toEqual({
        still: false,
        theme: "auto",
        lang: undefined,
        hideFinished: false,
      });
      expect(settingsOf({ still: true, theme: "dark", lang: "en", hideFinished: true })).toEqual({
        still: true,
        theme: "dark",
        lang: "en",
        hideFinished: true,
      });
    });
    it("トークン・チケット・ノード ID を残さない（保存の関数に、その名前が出てこない）", () => {
      for (const f of ["loadSettings", "saveSettings", "settingsOf"]) {
        expect(fnOf(f), f).not.toMatch(/token|ticket|session|nodeId|\.id\b/i);
      }
    });
  });

  it("走査から除く行は、埋め込んだ表の 4 行だけで、どれも JSON.stringify の値そのもの（#140・#141）", () => {
    const lines = UI_JS.split("\n").filter((l) => TABLE_LINE_ONE.test(l));
    expect(lines).toEqual([
      `  var TEXT = ${UI_TEXT_JSON};`,
      `  var MESSAGES = ${INBOX_MESSAGES_JSON};`,
      `  var SEPS = ${LIST_SEPS_JSON};`,
      `  var FAILURES = ${FAILURES_JSON};`,
    ]);
    expect(UI_JS.match(TABLE_LINE)).toHaveLength(4);
  });
  it("許可リスト: `.` の後ろのプロパティ名は、安全な集合にあるものだけ（文字列・コメントを除く）", () => {
    const SAFE = new Set([
      // 要素・文字列・集合・配列・Promise の、安全な操作
      // 移った先のカードへ focus を移すため（tabIndex = -1。カードを Tab の並びには入れない）
      "tabIndex",
      // 止まった子を、セッション番号で開くコマンドを組むため（表示モデルの nodes[].sessionRef。#150）
      "sessionRef",
      // 採用した子の開き方に、作業ツリーのパスを出すため（表示モデルの nodes[].adoptedWorktree。#159）
      "adoptedWorktree",
      // 受信箱の項目を人が片付ける・戻す（#99）: inbox.resolve・inbox.reopen の結果の鍵
      "resolved",
      "alreadyResolved",
      "resolvedAt",
      "reopened",
      // 画面の言語（#140）: ブラウザの言語・知らせの鍵と値・ページの文字の鍵（data-t・data-t-aria・data-t-title）
      "language",
      "args",
      "parts",
      "sep",
      "msg",
      "t",
      "tAria",
      "tTitle",
      // 失敗の帯の言語（#141）: 失敗の文の表（FAILURES.messages・none・sep）・画面が作った失敗の印（local）・値の分割
      "messages",
      "split",
      "none",
      "local",
      // 設定の窓（#139）。localStorage は、loadSettings・saveSettings の中だけ（上の「localStorage の使い所」の試験で確かめる）
      "still",
      "theme",
      "lang",
      // 関係図で、止めた・済んだ子を隠す（#206）。保存は同じ 2 つの関数の中
      "hideFinished",
      "localStorage",
      "getItem",
      "setItem",
      "querySelectorAll",
      "checked",
      "showModal",
      "close",
      "type",
      "shiftKey",
      "textContent",
      "className",
      "hidden",
      "value",
      "style",
      "paddingLeft",
      "firstChild",
      "removeChild",
      "appendChild",
      "forEach",
      "length",
      "size",
      "has",
      "get",
      "set",
      "add",
      "then",
      "catch",
      "status",
      "ok",
      "json",
      "headers",
      "truncated",
      "decisions",
      "extensions",
      "expectNodeIds",
      "blocked",
      "typed",
      "rows",
      "inputMode",
      "typedValue",
      "after",
      "filter",
      "toISOString",
      "replace",
      "map",
      "join",
      "isArray",
      "nodeIds",
      "every",
      "archivedAt",
      "elapsedDays",
      "retentionDays",
      "tombstoneTitle",
      "purgeable",
      "blockers",
      "discardedRefs",
      "hold",
      "until",
      // フックの結び付けを外した結果（node.hookUnbind の { unbound, duplicate }）
      "unbound",
      // 回答の結果の、再開しなかった子
      "notResumed",
      "shortId",
      "expiresAt",
      "attemptsLeft",
      "confirmationId",
      "contains",
      "approval",
      "spellcheck",
      "autocomplete",
      "ariaLabel",
      "runtime",
      "scrollIntoView",
      "tagName",
      "confirmations",
      "clear",
      "duplicate",
      "label",
      "days",
      "items",
      "key",
      "tip",
      "committedAt",
      "untrustedSubject",
      "target",
      "targetHidden",
      "inbox",
      "nodes",
      "lastSeq",
      "options",
      "question",
      "nodeId",
      "command",
      "reason",
      "priority",
      "kind",
      "at",
      "summary",
      "id",
      "role",
      "state",
      "parentId",
      "openItems",
      "unchanged",
      "preventDefault",
      "addEventListener",
      "getElementById",
      "createElement",
      "clearTimeout",
      "setTimeout",
      "hash",
      "session",
      "pathname",
      "search",
      "history",
      "replaceState",
      "location",
      "window",
      "document",
      "exec",
      "trim",
      "hasOwn",
      "resolve",
      "push",
      "Error",
      "Object",
      "Promise",
      "Map",
      "Set",
      "body",
      "discarded",
      "stopDelegated",
      "reclaimable",
      "unmet",
      "loss",
      "tips",
      "keys",
      "unknown",
      "workingTreeUnknown",
      "aheadCommits",
      "uncommitted",
      "untracked",
      "pid",
      "untrustedSubjects",
      "sort",
      "retryAt",
      "ceil",
      "optionsCut",
      "closedReason",
      "text",
      "from",
      "some",
      "test",
      "error",
      "code",
      "cause",
      "retry",
      "title",
      "lines",
      "sending",
      "disabled",
      "crypto",
      "randomUUID",
      "stringify",
      "requestId",
      "operation",
      "params",
      "activeElement",
      "dataset",
      "draft",
      "maxLength",
      "placeholder",
      "delete",
      "focus",
      // 入力欄の name（自動入力・支援技術のため）・確認を開いた直後の印・受信箱の帯
      "name",
      "justOpened",
      "cls",
      "setSelectionRange",
      "seq",
      "partial",
      "getReader",
      "read",
      "done",
      "decode",
      "indexOf",
      "slice",
      "min",
      "max",
      "floor",
      "random",
      "now",
      "signal",
      "abort",
      "Date",
      "Math",
      "AbortController",
      "TextDecoder",
      // 関係図（#89 の PR-5）：/ui/graph.js の入口と、見せ方の切り替えのボタンの押された印
      "touryouGraph",
      "draw",
      "destroy",
      // draw が返す、図の拡大・縮小の操作（graph.js の中で、いまの図にだけ効く。値は数だけ）
      "zoomBy",
      "fit",
      "ariaPressed",
      // 関係図の枠の高さを、描いた図に合わせる（draw の戻り値の height）
      "height",
      // #89: 画面の作り直し（表示モデルの値・時刻・写すボタン・動きを止める・たたむ欄）
      "title",
      "lastActivityAt",
      "needsHuman",
      "band",
      "stall",
      "flows",
      "dir",
      "to",
      "stage",
      "sentAt",
      "deliveryUnknown",
      "doneInferred",
      // 出した子が取り下げた判断のやり取り（#196。表示モデルの値 true）
      "withdrawn",
      "parse",
      "getHours",
      "getMinutes",
      "getFullYear",
      "getMonth",
      "getDate",
      "concat",
      "parentNode",
      "open",
      "navigator",
      "clipboard",
      "writeText",
      "classList",
      "toggle",
      "documentElement",
      "cli",
      "attachDir",
      // 紐付けが切れた子（#189。表示モデルの値 'idle' | 'absolute'）
      "bindExpired",
      // 相対時刻（「N 分前」）を、画面を描き直さずに計算し直す（#204）。基準の時刻・文の鍵・ほかの値を dataset に持たせ、interval で回す
      "tkey",
      "tvars",
      "setInterval",
      // 紐付けが外れているかもしれない子（表示モデルの値 true）
      "bindLost",
      // どの daemon の画面かを、作業場所の名前で示す（#197）
      "lastIndexOf",
      // Desktop の子を足してよい設定か（#159。表示モデルの値 true。設定の窓の注記を出すだけ）
      "desktopChildrenAllowed",
      // 設定の窓の規則（#194 PR4）。表示モデルの policy（規則の一覧・MCP ツールの判定）と、config.reload の結果、alsoLimit の送信
      "alsoLimit",
      "limitRules",
      "isComposing",
      "role",
      "policy",
      "mcpGate",
      "rules",
      "list",
      "rule",
      "source",
      "changed",
      "restartRequired",
      "overLimit",
      // 設定・管理の窓の幕のクリックで閉じる判定（押し始めと離した所の両方が窓の外のときだけ）
      "getBoundingClientRect",
      "clientX",
      "clientY",
      "left",
      "right",
      "top",
      "bottom",
      // 窓の見出し（h2）に焦点があるときの Shift+Tab を末尾へ回す判定（querySelectorAll と同じ読み取りの検索）
      "querySelector",
      // 確認の出所の印（管理の窓から出した確認だけ true。pending の中の真偽値）
      "fromAdmin",
      // 狭い画面の下のタブ（#254 の段階 2）: いま出している窓（dataset.view）と、選んでいるタブの印（aria-current）
      "view",
      "ariaCurrent",
    ]);
    // 埋め込んだ文字の表（#140。JSON の値で、コードでない）は、走査から除く
    const code = UI_JS.replace(TABLE_LINE, "")
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/\/\/[^\n]*/g, "");
    const used = new Set([...code.matchAll(/\.\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1] as string));
    expect(used.has("textContent")).toBe(true); // 抜き出せていること（空の集合で通らない）
    const unknown = [...used].filter((x) => !SAFE.has(x));
    expect(unknown).toEqual([]);
  });

  it("拡張要求の判定: scope.decide は、確認（openConfirm）を挟んでだけ送る。params は extensionId と decision だけ。対象が隠れていれば、却下以外のボタンを無効にする", () => {
    expect(UI_JS).toContain("'scope.decide'");
    expect(UI_JS).toContain("{ extensionId: x.id, decision: decision }");
    expect([...UI_JS.matchAll(/'scope\.decide'/g)]).toHaveLength(1);
    expect(UI_JS).toContain(
      "b.disabled = (x.targetHidden && decision !== 'reject') || (denied && decision === 'approve')",
    );
    // 「上限にも足して承認」: approve のときだけ alsoLimit: true を足して送る（確認を挟む。上限の規則は daemon が対象から作る）
    expect(UI_JS).toContain(
      "[['approve', false], ['approve', true], ['reject', false], ['split', false]]",
    );
    expect(UI_JS).toContain("if (also) params.alsoLimit = true;");
    // should 3: 上限に足せない依頼（daemon の limitRules に載らない）には、「上限にも足して承認」を出さない。確認には、足される規則の本文を出す
    expect(UI_JS).toContain("if (also && limitRule === '') return;");
    expect(UI_JS).toContain("lines.push([t('line.limitRule'), limitRule]);");
    // should 2: command の依頼には、前方一致（引数は問わない）の注意を足す
    expect(UI_JS).toContain(
      "if (x.kind === 'command') lines.push([t('line.note'), t('ext.alsoNoteCommand')]);",
    );
    expect(UI_JS).toContain("var denied = gate === 'deny';");
    expect(UI_JS).toContain("if (denied) card.appendChild(el('p', 'error', t('ext.denyNote')));");
    expect(UI_JS).toContain(
      "else if (gate === 'ask') card.appendChild(el('p', 'desc', t('ext.askNote')));",
    );
    // sendPending 以外に fetch がない（確認なしで送る経路がない）
    expect([...UI_JS.matchAll(/\bfetch\(\s*'\/v1\/request'/g)]).toHaveLength(1);
    // granted（許可する対象）を、画面から送らない
    expect(UI_JS).not.toContain("granted");
  });

  it("設定の窓の規則（#194 PR4）: 読み込み直し・足す・外すは、確認（openConfirm）を挟んでだけ送る。設定由来の規則には外すボタンを出さない", () => {
    expect([...UI_JS.matchAll(/'config\.reload'/g)]).toHaveLength(1);
    expect([...UI_JS.matchAll(/'policy\.ruleChange'/g)]).toHaveLength(1);
    expect(UI_JS).toContain("openConfirm(t('policy.reloadTitle')");
    expect(UI_JS).toContain("{ list: list, rule: r.rule, op: 'remove' }");
    expect(UI_JS).toContain("{ list: list, rule: rule, op: 'add' }");
    // 外せるのは、実行中に足した規則だけ
    expect(UI_JS).toContain("if (r.source === 'runtime') {");
    // 窓（モーダル）を閉じてから、確認の欄を出す
    expect(UI_JS).toContain("if (settingsBox.open) settingsBox.close();");
    // 結果の表示は、daemon の応答の値（配列）だけ。規則の本文は、本人が入力した値（と設定の値）だけを出す
    expect(UI_JS).toContain(
      "t('policy.reloaded', { changed: join(value && value.changed), restart: join(value && value.restartRequired), over: join(value && value.overLimit) })",
    );
    expect(UI_HTML).toContain('id="policy-reload"');
    expect(UI_HTML).toContain('id="policy-add"');
  });

  it("el に渡すタグは、div・span・p・button・textarea・details・summary・code・h3 だけ（実行時にも、許可リストで拒む。#89 で details・summary・code を、カードの題で h3 を足した）", () => {
    const calls = [...UI_JS.matchAll(/\bel\(\s*'([^']*)'/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(5);
    for (const tag of calls)
      expect([
        "div",
        "span",
        "p",
        "button",
        "textarea",
        "details",
        "summary",
        "code",
        "h3",
      ]).toContain(tag);
    expect(UI_JS).toContain(
      "var TAGS = { div: true, span: true, p: true, button: true, textarea: true, details: true, summary: true, code: true, h3: true };",
    );
    expect(UI_JS).toContain("Object.hasOwn(TAGS, tag)");
  });

  describe("やり取りの本文（#149）", () => {
    const fn = (name: string): string => {
      const at = UI_JS.indexOf(`function ${name}(`);
      expect(at, name).toBeGreaterThan(0);
      return UI_JS.slice(at, UI_JS.indexOf("\n  }\n", at) + 4);
    };
    const flowTextIn = (lang: "ja" | "en") =>
      runInNewContext(
        `var MESSAGES = ${INBOX_MESSAGES_JSON}; var SEPS = ${LIST_SEPS_JSON}; var MESSAGE_DEPTH_MAX = 3;
var PLACEHOLDER = /[{]([a-z][A-Za-z0-9]*)[}]/g; var lang = '${lang}';
${fn("msgText")}\n${fn("flowText")}\nflowText`,
      ) as (f: unknown) => string;
    const done = {
      text: "完了報告（根拠 3 件）",
      msg: { key: "doneReport", args: { count: 3 } },
    };

    it("msg つきの完了報告は、選んだ言語の文で出す（英語の画面に日本語を出さない）", () => {
      expect(flowTextIn("en")(done)).toBe("Done report (3 pieces of evidence)");
      expect(flowTextIn("ja")(done)).toBe("完了報告（根拠 3 件）");
      expect(flowTextIn("en")(done)).not.toMatch(/完了報告/);
    });
    it("msg のない古い記録・知らない鍵の記録は、書かれた text のまま出す", () => {
      expect(flowTextIn("en")({ text: "完了報告（根拠 3 件）" })).toBe("完了報告（根拠 3 件）");
      expect(flowTextIn("en")({ text: "古い文", msg: { key: "noSuchKey", args: {} } })).toBe(
        "古い文",
      );
      expect(flowTextIn("en")({})).toBe("");
    });
  });

  describe("失敗の帯の言語（#141）", () => {
    const fn = (name: string): string => {
      const at = UI_JS.indexOf(`function ${name}(`);
      expect(at, name).toBeGreaterThan(0);
      return UI_JS.slice(at, UI_JS.indexOf("\n  }\n", at) + 4);
    };
    // 画面の本物の failureText・failMsgText と、本物の表を、言語を決めて動かす
    const failureTextIn = (lang: "ja" | "en") =>
      runInNewContext(
        `var TEXT = ${UI_TEXT_JSON}; var FAILURES = ${FAILURES_JSON};
var PLACEHOLDER = /[{]([a-z][A-Za-z0-9]*)[}]/g; var lang = '${lang}';
function t(key) { return TEXT[key][lang]; }
${fn("failMsgText")}\n${fn("failureText")}\nfailureText`,
      ) as (e: unknown) => string;
    // 本物の daemon の失敗（応答の JSON と同じ形）
    const wire = (f: unknown): { code: string; cause: string; msg?: unknown } =>
      JSON.parse(JSON.stringify(f)) as { code: string; cause: string; msg?: unknown };
    const wrongCode = wire(
      failureMsg("confirmationInvalid", "confirmationWrongCode", { left: 3 }, "もう一度打つ"),
    );
    const tip = wire(
      failureMsg(
        "tipMismatch",
        "tipMismatchDone",
        { whenKey: "whenJustBeforeReclaim", idsList: "node-a,node-b", doneList: "" },
        "確かめ直す",
      ),
    );

    it("英語の画面は、msg から英語の文を作り、日本語の cause を出さない", () => {
      expect(failureTextIn("en")(wrongCode)).toBe("Wrong code (3 attempts left)");
      expect(failureTextIn("en")(tip)).toBe(
        "Just before reclaiming, the branch tip differs from what was shown (what was checked at the decision), or was not shown, for node(s): node-a, node-b (already reclaimed: none)",
      );
      for (const f of [wrongCode, tip]) expect(failureTextIn("en")(f)).not.toMatch(/[぀-ヿ㐀-鿿]/);
    });
    it("日本語の画面は、daemon の cause のまま（これまでと同じ文）", () => {
      expect(failureTextIn("ja")(wrongCode)).toBe("コードが違う（残り 3 回）");
      expect(failureTextIn("ja")(tip)).toBe(
        "回収の直前に、ブランチの先端が、表示した内容（判断のときに確かめた内容）と違う（または、表示になかった）ノード: node-a、node-b（回収済み: なし）",
      );
    });
    it("msg のない失敗・知らない鍵は、英語では汎用の文（日本語の cause を出さない）。画面が作った失敗は、そのまま", () => {
      const old = { code: "someOldFailure", cause: "古い daemon の文" };
      expect(failureTextIn("en")(old)).toBe("The request could not be completed");
      expect(failureTextIn("en")({ ...old, msg: { key: "noSuchKey", args: {} } })).toBe(
        "The request could not be completed",
      );
      expect(failureTextIn("en")({ code: "network", cause: "Cannot connect", local: true })).toBe(
        "Cannot connect",
      );
      expect(failureTextIn("ja")(old)).toBe("古い daemon の文");
    });
    it("画面の表示の 5 か所は、cause を直接出さず、failureText を通す", () => {
      expect(UI_JS).not.toMatch(/cause: r\.error\.cause/);
      expect(UI_JS).toContain("e.code + ': ' + failureText(e)");
    });
  });

  it("HTML に、インラインの script・style・イベント属性・javascript: を置かない（script は src だけ）", () => {
    const scripts = [...UI_HTML.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    // script は app.js と、そのあとの graph.js（関係図。#89）の 2 つだけ
    expect(scripts).toEqual(['<script src="/ui/app.js">', '<script src="/ui/graph.js">']);
    expect(UI_HTML).not.toMatch(/<script\b[^>]*>\s*[^<\s]/);
    expect(UI_HTML).not.toMatch(/<style\b/i);
    expect(UI_HTML).not.toMatch(/\sstyle\s*=/i);
    expect(UI_HTML).not.toMatch(/\son[a-z]+\s*=/i);
    expect(UI_HTML).not.toMatch(/javascript:/i);
    expect(UI_HTML).not.toMatch(/https?:\/\//i); // 外部の資産を読まない
    expect(UI_CSS).not.toMatch(/https?:\/\/|@import|url\s*\(/i);
  });

  it("トークンは、アドレスから消す処理（replaceState）が、最初の通信（fetch）より前にある", () => {
    const replace = UI_JS.indexOf("history.replaceState");
    const first = UI_JS.indexOf("fetch(");
    expect(replace).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(replace);
    // 最初の文（フラグメントの読み取り）から replaceState までに、通信・描画はない
    expect(UI_JS.slice(0, replace)).not.toMatch(/fetch\(|textContent/);
  });

  it("CSP は、既定で全てを禁じ、script・style・通信は同じ origin だけ。フレーム・form・base を禁じる", () => {
    const csp = UI_HEADERS["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(UI_HEADERS["x-content-type-options"]).toBe("nosniff");
    expect(UI_HEADERS["referrer-policy"]).toBe("no-referrer");
    expect(UI_HEADERS["cache-control"]).toBe("no-store");
    expect(UI_HEADERS["cross-origin-resource-policy"]).toBe("same-origin");
    expect(UI_HTML_HEADERS["cross-origin-opener-policy"]).toBe("same-origin");
    expect(UI_HTML_HEADERS["permissions-policy"]).toContain("camera=()");
  });

  describe("画面の純粋な部分（vm で評価する。new Function は使わない）", () => {
    // app.js から、純粋な関数と定数だけを取り出して、別の文脈で評価する（DOM・通信に触れない部分）
    const fn = (name: string): string => {
      const i = UI_JS.indexOf(`  function ${name}(`);
      expect(i, name).toBeGreaterThan(-1);
      return UI_JS.slice(i, UI_JS.indexOf("\n  }\n", i) + 5);
    };
    const line = (prefix: string): string => {
      const i = UI_JS.indexOf(`  ${prefix}`);
      expect(i, prefix).toBeGreaterThan(-1);
      return UI_JS.slice(i, UI_JS.indexOf("\n", i));
    };
    const api = runInNewContext(
      [
        // 画面の言語（#140）。文字は表から引く。既定は日本語（英語の試験は setLang で切り替える）
        line("var TEXT ="),
        line("var PLACEHOLDER ="),
        "var lang = 'ja';",
        fn("t"),
        line("var TEXT_MAX ="),
        line("var FORBIDDEN ="),
        line("var REASON_MAX ="),
        line("var EXPECT_TIPS_MAX ="),
        line("function cliHint("),
        line("var NODE_LIST_MAX ="),
        UI_JS.slice(
          UI_JS.indexOf("  var UNMET_NAMES = {"),
          UI_JS.indexOf("\n  };", UI_JS.indexOf("  var UNMET_NAMES = {")) + 5,
        ),
        line("function name("),
        fn("isReclaimPreview"),
        fn("reclaimBlocked"),
        fn("lossText"),
        fn("unmetLines"),
        fn("reclaimLines"),
        fn("failureHint"),
        line("var HOLD_MAX_DAYS ="),
        fn("parseDays"),
        fn("checkDays"),
        fn("typedMatches"),
        fn("purgeRoots"),
        fn("holdParams"),
        fn("holdDoneText"),
        fn("checkReason"),
        fn("cleanText"),
        fn("hasForbidden"),
        fn("checkAnswer"),
        fn("waitSecondsOf"),
        line("var FAILURES ="),
        fn("failMsgText"),
        fn("failureText"),
        fn("describeFailure"),
        fn("checkNote"),
        fn("confirmStoppedParams"),
        fn("confirmStoppedLines"),
        line("var ID_RE ="),
        "var NOT_RESUMED_TEXT = " +
          UI_JS.slice(
            UI_JS.indexOf("{", UI_JS.indexOf("var NOT_RESUMED_TEXT =")),
            UI_JS.indexOf("};", UI_JS.indexOf("var NOT_RESUMED_TEXT =")) + 2,
          ),
        fn("answerDoneText"),
        fn("hookUnbindLines"),
        fn("hookUnbindDoneText"),
        "var CONFIRM_OP_LABELS = " +
          UI_JS.slice(
            UI_JS.indexOf("{", UI_JS.indexOf("var CONFIRM_OP_LABELS =")),
            UI_JS.indexOf("};", UI_JS.indexOf("var CONFIRM_OP_LABELS =")) + 2,
          ),
        fn("approvalLines"),
        "({ setLang: function (l) { lang = l; }, approvalLines: approvalLines, answerDoneText: answerDoneText, hookUnbindLines: hookUnbindLines, hookUnbindDoneText: hookUnbindDoneText, checkNote: checkNote, confirmStoppedParams: confirmStoppedParams, confirmStoppedLines: confirmStoppedLines, isReclaimPreview: isReclaimPreview, reclaimBlocked: reclaimBlocked, reclaimLines: reclaimLines, failureHint: failureHint, checkAnswer: checkAnswer, waitSecondsOf: waitSecondsOf, describeFailure: describeFailure, typedMatches: typedMatches, purgeRoots: purgeRoots, holdParams: holdParams, holdDoneText: holdDoneText, parseDays: parseDays, checkDays: checkDays, checkReason: checkReason, cleanText: cleanText })",
      ].join("\n"),
      {},
    ) as {
      setLang(l: "ja" | "en"): void;
      checkAnswer(text: string): string;
      waitSecondsOf(r: { status: number; retry: number }): number;
      describeFailure(r: { status: number; body: unknown; retry: number }): string;
      typedMatches(typed: unknown, input: unknown): boolean;
      purgeRoots(nodes: { id: string; parentId: string | null; state: string }[]): { id: string }[];
      holdParams(nodeId: string, days: number, reason: string): Record<string, unknown>;
      holdDoneText(nodeId: string, value: unknown): string;
      parseDays(text: string): number;
      checkDays(text: string): string;
      checkReason(text: string): string;
      cleanText(text: string, max: number): string;
      checkNote(text: string): string;
      confirmStoppedParams(nodeId: string, note: string): Record<string, unknown>;
      confirmStoppedLines(nodeId: string, note: string): [string, string][];
      answerDoneText(value: unknown): string;
      hookUnbindLines(nodeId: string): [string, string][];
      hookUnbindDoneText(nodeId: string, value: unknown): string;
      approvalLines(c: Record<string, unknown>): [string, string][];
      isReclaimPreview(v: unknown): boolean;
      reclaimBlocked(v: unknown): string;
      reclaimLines(nodeId: string, v: unknown): [string, string][];
      failureHint(code: unknown): string;
    };

    it("checkAnswer: 空・空白だけ・長すぎる・制御文字・書式制御文字を拒む。タブ・改行は使える。長さは、コードポイントで数える", () => {
      expect(api.checkAnswer("")).toContain("空");
      expect(api.checkAnswer("   \n\t ")).toContain("空");
      expect(api.checkAnswer("はい")).toBe("");
      expect(api.checkAnswer("a".repeat(4000))).toBe("");
      expect(api.checkAnswer("a".repeat(4001))).toContain("長すぎ");
      expect(api.checkAnswer("😀".repeat(4000))).toBe(""); // 1 文字（サロゲートペア）を 1 と数える
      expect(api.checkAnswer("😀".repeat(4001))).toContain("長すぎ");
      for (const bad of [
        "a\u0007b",
        "a\u0000b",
        "a\u007fb",
        "a\u0085b",
        "a\u202eb",
        "a\u200bb",
        "a\ufeffb",
      ]) {
        expect(api.checkAnswer(bad), JSON.stringify(bad)).toContain("使えない文字");
      }
      expect(api.checkAnswer("一行目\n\t二行目")).toBe("");
    });

    it("停止の宣言: 根拠は任意（空白だけなら送らない）。長すぎ・制御文字は拒む。確認の表示は根拠を整えて出す", () => {
      expect(api.confirmStoppedParams("a", "")).toEqual({ nodeId: "a" });
      expect(api.confirmStoppedParams("a", "  ")).toEqual({ nodeId: "a" });
      expect(api.confirmStoppedParams("a", "アーカイブした")).toEqual({
        nodeId: "a",
        note: "アーカイブした",
      });
      expect(api.checkNote("")).toBe("");
      expect(api.checkNote("a".repeat(200))).toBe("");
      expect(api.checkNote("a".repeat(201))).toContain("長すぎ");
      expect(api.checkNote("a\u202eb")).toContain("使えない文字");
      // 見せたものを送る: 確認の表示と、送る値は、同じ整えた値
      const raw = "  アーカイブ   した  ";
      expect(api.confirmStoppedParams("a", raw)).toEqual({ nodeId: "a", note: "アーカイブ した" });
      const lines = api.confirmStoppedLines("a", raw);
      expect(lines[0]).toEqual(["ノード", "a"]);
      expect(lines.at(-1)).toEqual(["根拠", api.confirmStoppedParams("a", raw).note]);
      expect(api.checkNote("x\ny")).toContain("使えない文字"); // 1 行だけ
      expect(api.confirmStoppedLines("a", "").at(-1)).toEqual(["根拠", "（なし）"]);
    });

    it("回答の結果の文。再開しなかった子があれば ID と理由を添える。知らない理由・形の違う ID は出さない", () => {
      expect(api.answerDoneText({ accepted: true })).toBe("回答を送りました");
      expect(
        api.answerDoneText({
          accepted: true,
          notResumed: [
            { nodeId: "a", reason: "discarded" },
            { nodeId: "b", reason: "stoppedAfterStopIncomplete" },
            { nodeId: "c", reason: "stoppedByOther" },
            { nodeId: "d", reason: "toString" },
            { nodeId: "<img src=x>", reason: "discarded" },
          ],
        }),
      ).toBe(
        "回答を送りました。再開しなかった子: a（破棄の判断を経たため）、b（停止未完了のあと止め直したため。新しい子でやり直す）、c（判断のほかに止められたため）、d（理由は不明）",
      );
      expect(api.answerDoneText(null)).toBe("回答を送りました");
    });

    it("再開しなかった子は 10 件で切り、残りを「ほか N 件」と出す（形の違う ID は数えない）", () => {
      const many = Array.from({ length: 12 }, (_, i) => ({ nodeId: `n${i}`, reason: "discarded" }));
      const text = api.answerDoneText({
        accepted: true,
        notResumed: [...many, { nodeId: "<x>", reason: "discarded" }],
      });
      expect(text).toContain("n9（破棄の判断を経たため）、ほか 2 件");
      expect(text).not.toContain("n10");
      const ten = api.answerDoneText({ accepted: true, notResumed: many.slice(0, 10) });
      expect(ten).toContain("n9（破棄の判断を経たため）");
      expect(ten).not.toContain("ほか");
    });

    it("確認待ちの行。操作の名前・対象・番号の先頭（端末と見比べる）・期限。コードは持たない", () => {
      const lines = api.approvalLines({
        confirmationId: "cf-0123456789abcdef",
        shortId: "012345",
        operation: "node.purge",
        target: "t",
        expiresAt: "2026-10-28T00:05:00.000Z",
        attemptsLeft: 5,
      });
      expect(lines.map((l) => l[0])).toEqual(["操作", "対象", "確認の番号", "期限"]);
      expect(lines[0]?.[1]).toContain("最終削除");
      expect(lines[2]?.[1]).toContain("012345…");
      expect(lines[2]?.[1]).not.toContain("cf-0123456789abcdef");
      expect(lines[3]?.[1]).toContain("残り 5 回");
    });

    it("確認待ちの欄は、ページの上（判断待ちや確認の欄より前）にあり、上に固定される", () => {
      const a = UI_HTML.indexOf('id="approvals"');
      expect(a).toBeGreaterThan(-1);
      expect(a).toBeLessThan(UI_HTML.indexOf('id="confirm"'));
      expect(a).toBeLessThan(UI_HTML.indexOf('id="view"'));
      expect(UI_CSS).toMatch(/\.approvals\{position:sticky;top:0/);
      expect(api.failureHint("confirmationRequired")).toContain("確認待ち");
    });

    it("幅の区切り（#254 の段階 2）: 899px と 900px の境、900px〜の欄の高さの上限と窓の最小の高さ、下のタブの下の余白", () => {
      const narrow = UI_CSS.slice(UI_CSS.indexOf("@media (max-width:899px){"));
      expect(narrow).toMatch(
        /^@media \(max-width:899px\)\{\s*main\{padding-bottom:calc\(var\(--bar\) \+ 16px\)\}/,
      );
      const wideAt = UI_CSS.indexOf("@media (min-width:900px){");
      expect(wideAt).toBeGreaterThan(-1);
      const wide = UI_CSS.slice(wideAt, UI_CSS.indexOf("\n}", wideAt));
      expect(wide).toMatch(
        /\.approvals\{position:static;max-height:32vh;overflow:auto;flex:none\}/,
      );
      expect(wide).toMatch(/#confirm\{max-height:32vh;overflow:auto;flex:none\}/);
      expect(wide).toMatch(/#notice\{max-height:12vh;overflow:auto;flex:none\}/);
      expect(wide).toMatch(/\.stage\{flex:1;min-height:360px\}/);
      expect(wide).toMatch(/main\{[^}]*overflow:auto/);
      // 件数の札は読み上げず、隠した文で読む
      expect(UI_HTML).toMatch(/id="nav-count" class="bdg" aria-hidden="true"/);
      expect(UI_HTML).toContain('id="nav-count-sr" class="sr"');
      // 窓の見出し h2 の下の「いまの番」は h3
      expect(UI_HTML).toContain('<h3 id="now-title"');
    });

    it("フックの結び付けを外す確認の行と、結果の 3 通りの文", () => {
      const lines = api.hookUnbindLines("a");
      expect(lines[0]).toEqual(["ノード", "a"]);
      expect(lines.map((l) => l[0])).toEqual(["ノード", "内容", "記録", "注意"]);
      expect(lines.find((l) => l[0] === "注意")?.[1]).toContain("トークンが漏れた疑い");
      expect(lines.find((l) => l[0] === "内容")?.[1]).toContain(
        "（/clear・--resume で session_id が変わって、フックが拒否され続けるとき）",
      );
      expect(api.hookUnbindDoneText("a", { unbound: true, duplicate: false })).toContain(
        "外しました",
      );
      expect(api.hookUnbindDoneText("a", { unbound: false, duplicate: false })).toContain(
        "ありませんでした",
      );
      const dup = api.hookUnbindDoneText("a", { unbound: false, duplicate: true });
      expect(dup).toContain("すでに記録済み");
      expect(dup).not.toContain("ありませんでした");
    });

    it("waitSecondsOf: 429 は Retry-After の秒数（なければ 5 秒）。それ以外は 0", () => {
      expect(api.waitSecondsOf({ status: 429, retry: 3 })).toBe(3);
      expect(api.waitSecondsOf({ status: 429, retry: 0 })).toBe(5);
      expect(api.waitSecondsOf({ status: 429, retry: Number.NaN })).toBe(5);
      expect(api.waitSecondsOf({ status: 409, retry: 3 })).toBe(0);
      expect(api.waitSecondsOf({ status: 200, retry: 0 })).toBe(0);
    });

    it("describeFailure: code と cause を出す（cause は 300 文字まで）。本文がなければ HTTP の状態。429 は待つ秒数。再送の案内つき", () => {
      const a = api.describeFailure({
        status: 409,
        body: { ok: false, error: { code: "conflict", cause: "先に確定している" } },
        retry: 0,
      });
      expect(a).toContain("conflict: 先に確定している");
      // 判断の失敗（4xx）は、同じ内容を送り直しても、結果が変わらない。再送を勧めず、状態を確かめさせる
      expect(a).not.toContain("もう一度送れます");
      expect(a).toContain("結果は変わりません");
      const long = api.describeFailure({
        status: 422,
        body: { ok: false, error: { code: "x", cause: "あ".repeat(500) } },
        retry: 0,
      });
      expect(long).toContain(`x: ${"あ".repeat(300)}`);
      expect(long).not.toContain("あ".repeat(301));
      expect(api.describeFailure({ status: 500, body: null, retry: 0 })).toContain("HTTP 500");
      // 保留の期限は、daemon の時計で決める: 端末の時計のずれの案内は、もう出さない
      const clock = api.describeFailure({
        status: 422,
        body: { ok: false, error: { code: "invalidPurgeHoldUntil", cause: "範囲外" } },
        retry: 0,
      });
      expect(clock).not.toContain("この端末の時計");
      expect(
        api.describeFailure({
          status: 422,
          body: { ok: false, error: { code: "other", cause: "x" } },
          retry: 0,
        }),
      ).not.toContain("時計");
      expect(api.describeFailure({ status: 429, body: null, retry: 7 })).toContain("7 秒");
      expect(api.describeFailure({ status: 429, body: null, retry: 0 })).toContain("しばらく");
      // 再送して意味があるのは、待てば通りうる 429 だけ（ネットワークの失敗は、sendPending の catch で、再送を案内する）
      expect(api.describeFailure({ status: 429, body: null, retry: 3 })).toContain(
        "もう一度送れます",
      );
      for (const status of [400, 403, 404, 409, 422]) {
        const text = api.describeFailure({
          status,
          body: { ok: false, error: { code: "x", cause: "y" } },
          retry: 0,
        });
        expect(text, String(status)).not.toContain("もう一度送れます");
      }
    });

    it("typedMatches: 打ち込む文字列と完全に一致するときだけ。前後の空白・大文字小文字・全角・空・型の違いは、すべて不一致", () => {
      expect(api.typedMatches("root-1", "root-1")).toBe(true);
      expect(api.typedMatches("root-1", "root-1 ")).toBe(false);
      expect(api.typedMatches("root-1", " root-1")).toBe(false);
      expect(api.typedMatches("root-1", "ROOT-1")).toBe(false);
      expect(api.typedMatches("root-1", "ｒｏｏｔ-1")).toBe(false);
      expect(api.typedMatches("root-1", "root-")).toBe(false);
      expect(api.typedMatches("root-1", "")).toBe(false);
      expect(api.typedMatches("", "")).toBe(false); // 打ち込む文字列が空なら、決して一致しない
      expect(api.typedMatches(undefined, "")).toBe(false);
      expect(api.typedMatches(undefined, undefined)).toBe(false);
      expect(api.typedMatches("1", 1)).toBe(false);
    });

    it("purgeRoots: アーカイブ済みで、親がないか、親がアーカイブされていないノードだけ", () => {
      const nodes = [
        { id: "r", parentId: null, state: "archived" },
        { id: "c", parentId: "r", state: "archived" },
        { id: "m", parentId: null, state: "running" },
        { id: "a", parentId: "m", state: "archived" },
        { id: "o", parentId: "gone", state: "archived" },
        { id: "x", parentId: "m", state: "stopped" },
      ];
      expect(api.purgeRoots(nodes).map((n) => n.id)).toEqual(["r", "a", "o"]);
      expect(api.purgeRoots([])).toEqual([]);
    });

    it("holdParams: 日数は days で送る（期限は、daemon の時計で決める。until は送らない）。0 日は無期限（days なし）。空白だけの理由は送らない", () => {
      expect(api.holdParams("t", 0, "")).toEqual({ nodeId: "t" });
      expect(api.holdParams("t", 30, "調査中")).toEqual({
        nodeId: "t",
        days: 30,
        reason: "調査中",
      });
      // 365 日も、そのまま送る（端末の時計で、10 分短くしない）
      expect(api.holdParams("t", 365, "  ")).toEqual({ nodeId: "t", days: 365 });
      expect(api.holdParams("t", 90, "x")).not.toHaveProperty("until");
    });

    it("holdDoneText: 成功の通知に、daemon が決めた期限を出す（until がなければ無期限）。制御文字は除く", () => {
      expect(api.holdDoneText("t", { held: true, until: "2026-11-22T12:00:00Z" })).toBe(
        "保留しました（t）。期限: 2026-11-22T12:00:00Z",
      );
      expect(api.holdDoneText("t", { held: true })).toBe("保留しました（t）。期限: 無期限");
      expect(api.holdDoneText("t", undefined)).toBe("保留しました（t）。期限: 無期限");
      const dirty = api.holdDoneText("t", { until: "2026\u001b[2J-11-22" });
      expect(dirty).not.toContain("\u001b");
    });

    it("parseDays・checkDays: 1〜365 の整数だけ（前後の空白は可）。0・366・小数・負・全角・文字・空は不正", () => {
      expect(api.parseDays("1")).toBe(1);
      expect(api.parseDays(" 30 ")).toBe(30);
      expect(api.parseDays("365")).toBe(365);
      expect(api.parseDays("007")).toBe(7);
      for (const bad of [
        "",
        " ",
        "0",
        "366",
        "999",
        "1.5",
        "-1",
        "+1",
        "１０",
        "10日",
        "1e2",
        "1 0",
        "0x10",
      ]) {
        expect(api.parseDays(bad), JSON.stringify(bad)).toBe(0);
        expect(api.checkDays(bad), JSON.stringify(bad)).toContain("1〜365");
      }
      expect(api.checkDays("30")).toBe("");
    });

    it("checkReason: 空は可（任意）。長すぎる・制御文字・書式制御文字は拒む", () => {
      expect(api.checkReason("")).toBe("");
      expect(api.checkReason("   ")).toBe("");
      expect(api.checkReason("調査が済んだ")).toBe("");
      expect(api.checkReason("a".repeat(200))).toBe("");
      expect(api.checkReason("a".repeat(201))).toContain("長すぎ");
      expect(api.checkReason("a\u0007b")).toContain("使えない文字");
      expect(api.checkReason("a\u202eb")).toContain("使えない文字");
      expect(api.checkReason("a\nb")).toContain("使えない文字");
    });

    it("cleanText: 制御文字・書式制御文字を空白にして 1 行にし、長さを切る（信頼できない文字列）", () => {
      expect(api.cleanText("a\u001b[31mb\nc\u202ed", 100)).toBe("a [31mb c d");
      expect(api.cleanText("あ".repeat(10), 5)).toBe("ああああ…");
      expect(api.cleanText("  x   y  ", 10)).toBe("x y");
    });

    // ---- 回収の指示----
    const sha = (c: string): string => c.repeat(40);
    const preview = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      reclaimable: false,
      unmet: ["discardRequired"],
      blockers: [],
      loss: [],
      tips: { s1: sha("a") },
      ...over,
    });

    it("isReclaimPreview: 事前確認の結果の形（loss・tips は任意。あれば、形を確かめる）", () => {
      expect(api.isReclaimPreview(preview())).toBe(true);
      expect(api.isReclaimPreview(preview({ loss: undefined, tips: undefined }))).toBe(true);
      expect(api.isReclaimPreview(null)).toBe(false);
      expect(api.isReclaimPreview(preview({ reclaimable: "yes" }))).toBe(false);
      expect(api.isReclaimPreview(preview({ unmet: "x" }))).toBe(false);
      expect(api.isReclaimPreview(preview({ blockers: {} }))).toBe(false);
      expect(api.isReclaimPreview(preview({ loss: {} }))).toBe(false);
      expect(api.isReclaimPreview(preview({ tips: [] }))).toBe(false);
      expect(api.isReclaimPreview(preview({ tips: { s1: 1 } }))).toBe(false);
    });

    it("reclaimBlocked: loss がない・調べられなかったノードがある・先端が多すぎるときは、送れない（cli で確かめる案内つき）。それ以外は ''", () => {
      expect(api.reclaimBlocked(preview())).toBe("");
      expect(api.reclaimBlocked(preview({ loss: undefined }))).toContain("touryou reclaim");
      const unknown = api.reclaimBlocked(
        preview({
          loss: [
            {
              nodeId: "s2",
              unknown: true,
              untrustedSubjects: [],
              uncommitted: false,
              untracked: 0,
            },
          ],
        }),
      );
      expect(unknown).toContain("s2");
      expect(unknown).toContain("touryou reclaim");
      expect(
        api.reclaimBlocked(
          preview({
            loss: [
              {
                nodeId: "s3",
                workingTreeUnknown: true,
                untrustedSubjects: [],
                uncommitted: false,
                untracked: 0,
              },
            ],
          }),
        ),
      ).toContain("s3");
      const many = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`n${i}`, sha("b")]));
      expect(api.reclaimBlocked(preview({ tips: many }))).toBe("");
      expect(api.reclaimBlocked(preview({ tips: { ...many, extra: sha("c") } }))).toContain(
        "多すぎ",
      );
      // 失われるものがない（loss が空）・先端がない（作業ツリーがない）のは、送れる
      expect(api.reclaimBlocked(preview({ tips: undefined }))).toBe("");
    });

    it("reclaimLines: 対象・取り消せない旨・失われるもの・先端（先頭 12 桁）・照合の説明を出す。件名は整える。パスを出さない", () => {
      const lines = api.reclaimLines(
        "s1",
        preview({
          unmet: ["discardRequired", "processesRunning"],
          blockers: [
            { kind: "process", reason: "processesRunning", pid: 1234 },
            { kind: "node", reason: "dirty", nodeId: "s1" },
          ],
          loss: [
            {
              nodeId: "s1",
              aheadCommits: 2,
              untrustedSubjects: ["fix: a\u001b[31mred\u202e", "<img src=x onerror=1>"],
              uncommitted: true,
              untracked: 3,
            },
          ],
          tips: { s1: `${"ab12".repeat(10)}` },
        }),
      );
      const text = lines.map((l) => l.join(" ")).join("\n");
      expect(lines[0]).toEqual(["対象", "s1"]);
      expect(text).toContain("取り消せません");
      expect(text).toContain("配下の停止ノードは、別に指示が必要");
      expect(text).toContain("破棄の判断が要る");
      expect(text).toContain("プロセス 1234");
      expect(text).toContain(
        "失われるもの（この対象と配下。配下は、それぞれの指示のときに失われる） 1 件のノード",
      );
      expect(text).toContain("ノード s1 統合されていないコミット 2 件");
      expect(text).toContain("統合されていないコミット 2 件");
      expect(text).toContain("追跡中のファイルの未保存の変更あり");
      expect(text).toContain("未追跡のファイル 3 件");
      expect(text).toContain("ab12ab12ab12"); // 先端の先頭 12 桁
      expect(text).not.toContain("ab12ab12ab12a"); // 13 桁目は出さない
      expect(text).toContain("<img src=x onerror=1>"); // 文字として出す（textContent で描く）
      expect(text).not.toContain("\u001b"); // 制御文字は除く
      expect(text).not.toContain("\u202e");
      expect(text).toContain("先端が変わっていたら、何も記録されません");
    });

    it("reclaimLines: 失われるものがなければ「なし」。長い一覧（20 件超）は切り、「ほか N 件」を出す（先端は、すべて照合に含める）", () => {
      const none = api
        .reclaimLines("s1", preview({ tips: undefined }))
        .map((l) => l.join(" "))
        .join("\n");
      expect(none).toContain(
        "失われるもの（この対象と配下。配下は、それぞれの指示のときに失われる） なし",
      );
      const many = api.reclaimLines(
        "s1",
        preview({
          loss: Array.from({ length: 30 }, (_, i) => ({
            nodeId: `n${i}`,
            untrustedSubjects: [],
            uncommitted: false,
            untracked: 0,
            aheadCommits: 0,
          })),
          tips: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`n${i}`, sha("d")])),
        }),
      );
      expect(many.filter((l) => l[0].startsWith("  ノード n")).length).toBe(20);
      expect(many.filter((l) => l[0].startsWith("ブランチの先端（")).length).toBe(20);
      expect(many).toContainEqual([
        "  失われるもの",
        "ほか 10 件（表示を省略。破棄の対象には、すべて含まれる）",
      ]);
      expect(many).toContainEqual(["ブランチの先端", "ほか 10 件（すべて、照合に含める）"]);
      // ちょうど 20 件なら、「ほか」は出さない
      const exact = api.reclaimLines(
        "s1",
        preview({
          tips: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`n${i}`, sha("e")])),
        }),
      );
      expect(exact.some((l) => l[1].startsWith("ほか"))).toBe(false);
    });

    it("reclaimLines: プロセスの名前を整えて添える。文字列でない・空の名前は出さない", () => {
      const blockers = [
        {
          kind: "process",
          reason: "processesRunning",
          pid: 1,
          command: "<img src=x onerror=alert(1)>\u001b",
        },
        { kind: "process", reason: "processesRunning", pid: 2, command: 42 },
        { kind: "process", reason: "processesRunning", pid: 3 },
      ];
      const causes = api
        .reclaimLines("s1", preview({ unmet: ["processesRunning"], blockers }))
        .filter((l) => l[0] === "原因")
        .map((l) => l[1]);
      expect(causes[0]).toMatch(/^プロセス 1（<img src=x onerror=alert\(1\)>）（/);
      expect(causes[0]).not.toContain("\u001b");
      expect(causes[1]).toMatch(/^プロセス 2（/);
      expect(causes[1]).not.toContain("42");
      expect(causes[2]).toMatch(/^プロセス 3（/);
    });

    it("reclaimLines: 満たしていない条件・原因を 10 件で切ったときも、「ほか N 件」を出す", () => {
      const unmet = Array.from({ length: 12 }, () => "dirty");
      const blockers = Array.from({ length: 13 }, (_, i) => ({
        kind: "process",
        reason: "processesRunning",
        pid: 100 + i,
      }));
      const lines = api.reclaimLines("s1", preview({ unmet, blockers }));
      expect(
        lines.filter((l) => l[0] === "満たしていない条件" && !l[1].startsWith("ほか")).length,
      ).toBe(10);
      expect(lines).toContainEqual(["満たしていない条件", "ほか 2 件"]);
      expect(lines.filter((l) => l[0] === "原因" && !l[1].startsWith("ほか")).length).toBe(10);
      expect(lines).toContainEqual(["原因", "ほか 3 件"]);
      // 10 件ちょうどなら、「ほか」は出さない
      const ten = api.reclaimLines(
        "s1",
        preview({ unmet: unmet.slice(0, 10), blockers: blockers.slice(0, 10) }),
      );
      expect(ten.some((l) => l[1].startsWith("ほか"))).toBe(false);
    });

    it("failureHint・describeFailure: tipMismatch・tipUnknown は、同じ内容の再送でなく、確かめ直しを案内する", () => {
      expect(api.failureHint("tipMismatch")).toContain("確かめ直して");
      expect(api.failureHint("tipUnknown")).toContain("確かめ直して");
      expect(api.failureHint("conflict")).toBe("");
      const mismatch = api.describeFailure({
        status: 422,
        body: { ok: false, error: { code: "tipMismatch", cause: "先端が違う" } },
        retry: 0,
      });
      expect(mismatch).toContain("tipMismatch: 先端が違う");
      expect(mismatch).toContain("何も指示していません");
      expect(mismatch).not.toContain("同じ内容で、もう一度送れます");
    });
  });

  describe("sendPending（vm で評価する。打ち込みが一致しないと、通信しない）", () => {
    const fn = (name: string): string => {
      const i = UI_JS.indexOf(`  function ${name}(`);
      expect(i, name).toBeGreaterThan(-1);
      return UI_JS.slice(i, UI_JS.indexOf("\n  }\n", i) + 5);
    };
    type Pending = {
      operation: string;
      params: unknown;
      requestId: string;
      sending: boolean;
      error: string;
      retryAt: number;
      typed?: string;
      typedValue: string;
      blocked: string;
      done: string;
    };
    const run = (p: Pending) => {
      const sent: { operation: string; params: unknown; requestId: string }[] = [];
      const ctx = {
        __pending: p,
        __sent: sent,
        __callOperation: (operation: string, params: unknown, requestId: string) => {
          sent.push({ operation, params, requestId });
          return new Promise(() => {}); // 返さない（送った、までを見る）
        },
      };
      const source = [
        "var pending = __pending;",
        "function callOperation(o, p, r) { return __callOperation(o, p, r); }",
        "function renderConfirm() {}",
        "function notice() {}",
        "function refresh() {}",
        "function describeFailure() { return ''; }",
        "function waitSecondsOf() { return 0; }",
        fn("typedMatches"),
        fn("sendPending"),
        "sendPending();",
      ].join("\n");
      runInNewContext(source, ctx);
      return sent;
    };
    const base = (over: Partial<Pending>): Pending => ({
      operation: "node.purge",
      params: { nodeId: "r1" },
      requestId: "req-1",
      sending: false,
      error: "",
      retryAt: 0,
      typedValue: "",
      blocked: "",
      done: "ok",
      ...over,
    });

    it("打ち込みが一致しなければ、通信しない（画面の無効化を迂回されても）", () => {
      for (const typedValue of ["", "r", "r1 ", " r1", "R1", "ｒ１"]) {
        expect(run(base({ typed: "r1", typedValue })), JSON.stringify(typedValue)).toEqual([]);
      }
    });

    it("打ち込みが一致すれば、1 回だけ通信する（同じ requestId・params）", () => {
      expect(run(base({ typed: "r1", typedValue: "r1" }))).toEqual([
        { operation: "node.purge", params: { nodeId: "r1" }, requestId: "req-1" },
      ]);
    });

    it("送れない理由（blocked）があれば、一致していても通信しない。typed がない（取り消せる）操作は、そのまま送る。送信中は送らない", () => {
      expect(run(base({ typed: "r1", typedValue: "r1", blocked: "実行できない" }))).toEqual([]);
      expect(run(base({}))).toHaveLength(1);
      expect(run(base({ sending: true }))).toEqual([]);
    });
  });

  it("保留の日数の入力欄は、inputMode='numeric'（プロパティ。setAttribute は使わない。input タグは許可リストに足さない）。askHold は var の関数式", () => {
    expect(UI_JS).toContain("daysArea.inputMode = 'numeric'");
    expect(UI_JS).toContain("var askHold = function (label, days)");
    expect(UI_JS).not.toContain("function askHold");
    expect(UI_JS).not.toContain("setAttribute");
  });

  it("通信は callOperation の 1 か所だけ。最終削除・保管の削除は、打ち込みの確認（typed）を経る。保管の削除は一覧で見た先端を渡す", () => {
    expect([...UI_JS.matchAll(/\bfetch\(\s*'\/v1\/request'/g)]).toHaveLength(1);
    // 取り消せない操作の openConfirm は、typed を指定している
    for (const op of ["'node.purge'", "'node.discardedDrop'"]) {
      const i = UI_JS.indexOf(`openConfirm(`, UI_JS.indexOf(op) - 600);
      expect(UI_JS.slice(i, UI_JS.indexOf(op) + 400), op).toContain("typed:");
    }
    expect(UI_JS).toContain("expectTip: i.tip");
    // 送る側にも、打ち込みの検査がある（画面の無効化を迂回されても送らない）
    expect(UI_JS).toContain("typedMatches(p.typed, p.typedValue)");
    // 取り出しのブランチ名は、入力させない（既定だけ）
    expect(UI_JS).not.toContain("branch:");
    // 読み取りの操作は、確認なしで呼ぶのは事前確認と一覧だけ
    const reads = [...UI_JS.matchAll(/readOperation\('([^']+)'/g)].map((m) => m[1]);
    expect(new Set(reads)).toEqual(new Set(["node.purgePreview", "node.discardedList"]));
  });

  it("回収の指示は、打ち込みの確認（typed: 対象のノード ID）を経る。見せた先端（プレビューの tips）を、作り直さずに、そのまま expectTips に渡す", () => {
    const start = UI_JS.indexOf("function startReclaim(");
    expect(start).toBeGreaterThan(-1);
    const body = UI_JS.slice(start, UI_JS.indexOf("\n  }\n", start));
    expect(body).toContain("readOperationResult('node.reclaimPreview'");
    expect(body).toContain("expectTips: v.tips || {}");
    expect(body).toContain("'node.reclaimInstruct'");
    expect(body).toContain("typed: nodeId");
    expect(body).toContain("blocked: reclaimBlocked(v)");
    // 先端を取り直す・作り直す経路がない（プレビューは、確認を出す前の 1 回だけ）
    expect(body.split("node.reclaimPreview").length - 1).toBe(1);
    expect(body).not.toMatch(/expectTips:\s*\{[^}]/);
    // 通信は、callOperation の 1 か所だけ（reclaimInstruct も、sendPending 経由）
    expect(UI_JS.split("fetch('/v1/request'").length - 1).toBe(1);
    // ボタンは、停止したノードだけ。指示済みには出さない
    expect(UI_JS).toContain("n.state === 'stopped'");
    expect(UI_JS).toContain("n.discarded");
  });

  it("フックの結び付けを外すボタンは、動いている子（統合ノードでなく running・waiting）だけに出し、打ち込みはなく { nodeId } を送る", () => {
    expect(UI_JS).toContain(
      "n.role !== 'integrator' && (n.state === 'running' || n.state === 'waiting') && ID_RE.test(n.id)",
    );
    const start = UI_JS.indexOf("function hookUnbindButton(");
    const body = UI_JS.slice(start, UI_JS.indexOf("\n  }\n", start));
    expect(body).toContain("'node.hookUnbind', { nodeId: nodeId }");
    expect(body).not.toContain("typed:");
  });

  it("停止の宣言は、停止未完了かつ stopDelegated のノードだけに出し、打ち込みの確認（typed: ノード ID）を経る", () => {
    expect(UI_JS).toContain(
      "n.state === 'stopIncomplete' && n.stopDelegated === true && ID_RE.test(n.id)",
    );
    const start = UI_JS.indexOf("function confirmStoppedBox(");
    const body = UI_JS.slice(start, UI_JS.indexOf("\n  }\n", start));
    expect(body).toContain("'node.confirmStopped'");
    expect(body).toContain("typed: nodeId");
    expect(body).toContain("confirmStoppedParams(nodeId, note)");
    expect(UI_JS.split("fetch('/v1/request'").length - 1).toBe(1);
  });
});

describe("画面の使い勝手（#13）", () => {
  const fnOf = (name: string): string => {
    const i = UI_JS.indexOf(`  function ${name}(`);
    expect(i, name).toBeGreaterThan(-1);
    return UI_JS.slice(i, UI_JS.indexOf("\n  }\n", i) + 5);
  };
  const lineOf = (prefix: string): string => {
    const i = UI_JS.indexOf(`  ${prefix}`);
    expect(i, prefix).toBeGreaterThan(-1);
    return UI_JS.slice(i, UI_JS.indexOf("\n", i));
  };
  const uiContext: Record<string, unknown> = {};
  const api = runInNewContext(
    [
      lineOf("var attachDir ="),
      lineOf("function shellQuote("),
      lineOf("var PRIORITY_NAMES ="),
      lineOf("var EXTERNAL_CHECK_PREFIXES ="),
      lineOf("var EXTERNAL_CHECK_KEYS ="),
      lineOf("var TEXT ="),
      lineOf("var PLACEHOLDER ="),
      "var lang = 'ja';",
      fnOf("t"),
      lineOf("function unreachableText("),
      lineOf("var ID_RE ="),
      lineOf("var FORBIDDEN ="),
      lineOf("function name("),
      fnOf("isStopRequest"),
      fnOf("inboxBand"),
      fnOf("fetchFailureText"),
      fnOf("timeText"),
      fnOf("agoText"),
      fnOf("whenText"),
      fnOf("refreshTimes"),
      fnOf("stageText"),
      fnOf("attachWith"),
      fnOf("attachCommand"),
      fnOf("attachCommandByRef"),
      fnOf("attachCommands"),
      fnOf("cleanText"),
      lineOf("function nodeLabel("),
      "({ inboxBand: inboxBand, fetchFailureText: fetchFailureText, UNREACHABLE_TEXT: unreachableText(), timeText: timeText, agoText: agoText, whenText: whenText, refreshTimes: refreshTimes, stageText: stageText, attachCommand: attachCommand, attachCommandByRef: attachCommandByRef, attachCommands: attachCommands, nodeLabel: nodeLabel })",
    ].join("\n"),
    uiContext,
  ) as {
    inboxBand(i: Record<string, unknown>, delegated: Set<string>): { cls: string; label: string };
    fetchFailureText(status: number): string;
    UNREACHABLE_TEXT: string;
    timeText(iso: unknown, nowMs: number): string;
    agoText(ms: number): string;
    whenText(
      iso: unknown,
      key: string,
      vars: Record<string, string> | undefined,
      nowMs: number,
    ): string;
    refreshTimes(nowMs: number): void;
    stageText(f: Record<string, unknown>): string;
    attachCommand(n: unknown): string;
    attachCommandByRef(n: unknown): string;
    attachCommands(n: unknown): string[];
    nodeLabel(n: unknown, max: number): string;
  };

  it("(4) 停止を代行してもらうノードの停止未完了は、赤の「失敗」でなく「停止の代行依頼」。直接止めるノードは、これまでどおり失敗", () => {
    const delegated = new Set(["c1"]);
    expect(
      api.inboxBand({ kind: "stopIncomplete", nodeId: "c1", priority: "failed" }, delegated),
    ).toEqual({ cls: "request", label: "停止の代行依頼" });
    expect(
      api.inboxBand({ kind: "stopIncomplete", nodeId: "c2", priority: "failed" }, delegated),
    ).toEqual({ cls: "failed", label: "失敗" });
    expect(api.inboxBand({ kind: "failure", nodeId: "c1", priority: "failed" }, delegated)).toEqual(
      { cls: "failed", label: "失敗" },
    );
    expect(api.inboxBand({ kind: "info", nodeId: "c1", priority: "info" }, delegated)).toEqual({
      cls: "",
      label: "情報",
    });
  });

  it("(4) 根に出る、Desktop の子を人が確かめる依頼（今の版・前の版の文面）も、「停止の代行依頼」。ほかの根の停止未完了は失敗", () => {
    const none = new Set<string>();
    for (const summary of externalCheckSummaries())
      expect(
        api.inboxBand(
          {
            kind: "stopIncomplete",
            nodeId: "root",
            priority: "failed",
            summary: `${summary}（1 件: c1）`,
          },
          none,
        ),
      ).toEqual({ cls: "request", label: "停止の代行依頼" });
    expect(
      api.inboxBand(
        { kind: "stopIncomplete", nodeId: "root", priority: "failed", summary: "別の停止未完了" },
        none,
      ).cls,
    ).toBe("failed");
    expect(
      api.inboxBand(
        { kind: "failure", nodeId: "root", priority: "failed", summary: EXTERNAL_CHECK_SUMMARY },
        none,
      ).cls,
    ).toBe("failed");
    // 鍵と値で書いた依頼（#140）は、文面でなく鍵で見分ける（英語の画面でも同じ）
    for (const key of ["externalCheck", "externalCheckMore"])
      expect(
        api.inboxBand(
          {
            kind: "stopIncomplete",
            nodeId: "root",
            priority: "failed",
            summary: "x",
            msg: { key, args: {} },
          },
          none,
        ).cls,
      ).toBe("request");
  });

  it("(6) 「あなたの答え」の数は、人の操作が要るもの（needsHuman）だけ。未解決の項目すべて（openItems）は使わない（#89）", () => {
    expect(UI_JS).toContain(
      "if (n.needsHuman > 0) head.appendChild(el('span', 'chip turn', t('card.needsHuman', { n: n.needsHuman })))",
    );
    expect(UI_JS).not.toContain("openItems");
  });

  it("(#89) 時刻は手元の時刻と経過で出す。今日でない日は日付も。読めない値は空", () => {
    const now = new Date(2026, 10, 17, 15, 0, 0).getTime();
    expect(api.timeText(new Date(2026, 10, 17, 14, 57, 0).toISOString(), now)).toBe(
      "14:57（3 分前）",
    );
    expect(api.timeText(new Date(2026, 10, 16, 9, 5, 0).toISOString(), now)).toBe(
      "11/16 09:05（1 日前）",
    );
    expect(api.timeText("壊れた", now)).toBe("");
    expect(api.timeText(undefined, now)).toBe("");
    expect(api.agoText(30_000)).toBe("いま");
    expect(api.agoText(2 * 3_600_000)).toBe("2 時間前");
  });

  it("(#204) 相対時刻は nowMs を渡して計算し直せる。言葉の境目は、これまでと同じ", () => {
    const at = new Date(2026, 10, 17, 14, 0, 0);
    const iso = at.toISOString();
    const after = (ms: number) => at.getTime() + ms;
    expect(api.whenText(iso, "", undefined, after(30_000))).toBe("14:00（いま）");
    expect(api.whenText(iso, "", undefined, after(60_000))).toBe("14:00（1 分前）");
    expect(api.whenText(iso, "", undefined, after(59 * 60_000))).toBe("14:00（59 分前）");
    expect(api.whenText(iso, "", undefined, after(60 * 60_000))).toBe("14:00（1 時間前）");
    // 文の鍵があれば、{when} に入れる（鍵のない値は、そのまま）
    expect(api.whenText(iso, "card.last", undefined, after(5 * 60_000))).toBe(
      api.whenText(iso, "card.last", {}, after(5 * 60_000)),
    );
    expect(api.whenText(iso, "card.last", undefined, after(5 * 60_000))).toContain("5 分前");
    // 読めない値は、時刻の部分が空
    expect(api.whenText("壊れた", "", undefined, after(0))).toBe("");
  });

  it("(#204) refreshTimes は、要素を作り直さず、変わった文字だけ書き直す", () => {
    const at = new Date(2026, 10, 17, 14, 0, 0);
    const iso = at.toISOString();
    const makeEl = (dataset: Record<string, string>, textContent: string) => ({
      dataset,
      textContent,
      writes: 0,
    });
    const plain = makeEl({ at: iso }, "14:00（いま）");
    const keyed = makeEl({ at: iso, tkey: "card.last", tvars: "{}" }, "");
    const broken = makeEl({ at: iso, tvars: "{壊れた" }, "");
    // textContent への書き込みを数える（同じ文字なら、書かない）
    for (const e of [plain, keyed, broken]) {
      let value = e.textContent;
      Object.defineProperty(e, "textContent", {
        get: () => value,
        set: (v: string) => {
          e.writes += 1;
          value = v;
        },
      });
    }
    uiContext.document = { querySelectorAll: () => [plain, keyed, broken] };
    const t0 = at.getTime();
    api.refreshTimes(t0 + 30_000);
    expect(plain.textContent).toBe("14:00（いま）");
    expect(plain.writes).toBe(0);
    api.refreshTimes(t0 + 3 * 60_000);
    expect(plain.textContent).toBe("14:00（3 分前）");
    expect(plain.writes).toBe(1);
    expect(keyed.textContent).toContain("3 分前");
    // vars が壊れていても、止まらない
    expect(broken.textContent).toBe("14:00（3 分前）");
    // 変わらないなら、書かない
    api.refreshTimes(t0 + 3 * 60_000 + 10_000);
    expect(plain.writes).toBe(1);
  });

  it("(#204) 相対時刻の要素は、基準の時刻を持つ。interval・前面に戻った瞬間・focus で計算し直す", () => {
    expect(UI_JS).toContain("e.dataset.at = ");
    expect(UI_JS).toContain(
      "window.setInterval(function () { refreshTimes(Date.now()); }, TIME_TICK_MS)",
    );
    const visible = UI_JS.slice(UI_JS.indexOf("document.addEventListener('visibilitychange'"));
    expect(visible.slice(0, visible.indexOf("window.addEventListener('focus'"))).toContain(
      "refreshTimes(Date.now())",
    );
    const focus = visible.slice(visible.indexOf("window.addEventListener('focus'"));
    expect(focus.slice(0, focus.indexOf("});"))).toContain("refreshTimes(Date.now())");
    // 呼び出しは、すべて whenEl 経由（描き直しのときだけ計算する書き方を残さない）
    expect(UI_JS).not.toMatch(/el\([^\n]*timeText\(/);
  });

  it("(#89) やり取りの段の言葉。届いたかの記録がない・推定は、そう言う", () => {
    expect(api.stageText({ stage: "sent" })).toBe("送った（まだ届いていない）");
    expect(api.stageText({ stage: "sent", deliveryUnknown: true })).toBe(
      "送った（届いたかは分からない）",
    );
    expect(api.stageText({ stage: "delivered" })).toBe("届いた（返事を待っている）");
    expect(api.stageText({ stage: "done" })).toBe("済んだ");
    expect(api.stageText({ stage: "done", doneInferred: true })).toBe("済んだ（推定）");
    expect(api.stageText({ stage: "x" })).toBe("");
  });

  it("(#89・#136) 止まっているかもの子を開くコマンドは、CLI の子にだけ出す。repoRoot に移ってから claude attach <ノード ID>。ID の形でないものには出さない。セッションの ID は使わない", () => {
    uiContext.attachDir = "";
    expect(api.attachCommand({ id: "n-a1", cli: true })).toBe("claude attach n-a1");
    // CLI の子にも stopDelegated は付く（#136）。cli で見分ける
    expect(api.attachCommand({ id: "n-a1", cli: true, stopDelegated: true })).toBe(
      "claude attach n-a1",
    );
    expect(api.attachCommand({ id: "n-a1", stopDelegated: true })).toBe(""); // Desktop の子
    expect(api.attachCommand({ id: "n-a1" })).toBe("");
    expect(api.attachCommand({ id: "a b; rm -rf", cli: true })).toBe("");
    expect(api.attachCommand(undefined)).toBe("");
    uiContext.attachDir = "/r/my repo's";
    expect(api.attachCommand({ id: "n-a1", cli: true })).toBe(
      "cd '/r/my repo'\\''s' && claude attach n-a1",
    );
    // 引用符・空白・展開の字を含んでも、1 つの語として渡る（試験の外で bash に通して確かめた）
    uiContext.attachDir = "/r/x'; touch y; echo '$(z)";
    expect(api.attachCommand({ id: "n-a1", cli: true })).toBe(
      "cd '/r/x'\\''; touch y; echo '\\''$(z)' && claude attach n-a1",
    );
    // 改行などの制御文字を含む場所には、移る部分を付けない
    uiContext.attachDir = "/r/a\nb";
    expect(api.attachCommand({ id: "n-a1", cli: true })).toBe("claude attach n-a1");
    uiContext.attachDir = "";
    expect(UI_JS).not.toContain("sessionId");
    expect(UI_JS).toContain(
      "attachDir = typeof view.attachDir === 'string' ? view.attachDir : '';",
    );
  });

  it("(#197) ヘッダーに、どの daemon の画面か（作業場所の名前。全体は title）を示す。文は i18n の鍵", () => {
    expect(UI_HTML).toContain('<span id="daemon-where" class="status" hidden></span>');
    expect(UI_JS).toContain("document.getElementById('daemon-where')");
    expect(UI_JS).toContain("where.title = t('page.where') + ': ' + attachDir;");
    expect(UI_TEXT_TABLE["page.where"]?.ja).toContain("daemon");
  });

  it("(#150・#205) セッション番号があるときは、動いていても止まっていても開ける番号の形だけを出す。番号がないときだけ名前の形を出す", () => {
    uiContext.attachDir = "/r";
    const child = { id: "n-a1", cli: true, sessionRef: "bg-1234" };
    expect(api.attachCommandByRef(child)).toBe("cd '/r' && claude attach bg-1234");
    // 番号が分かるときは、コマンドは 1 つ（番号の形）。名前の形は並べない
    expect(api.attachCommands(child)).toEqual(["cd '/r' && claude attach bg-1234"]);
    // 番号がない・形が不正・CLI の子でないものには、番号の形を出さない（名前の形だけ）
    expect(api.attachCommands({ id: "n-a1", cli: true })).toEqual([
      "cd '/r' && claude attach n-a1",
    ]);
    expect(api.attachCommands({ id: "n-a1", cli: true, sessionRef: "a b; rm -rf" })).toEqual([
      "cd '/r' && claude attach n-a1",
    ]);
    expect(api.attachCommandByRef({ id: "n-a1", cli: true, sessionRef: "a b; rm -rf" })).toBe("");
    expect(api.attachCommandByRef({ id: "n-a1", sessionRef: "bg-1234" })).toBe("");
    expect(api.attachCommands(undefined)).toEqual([]);
    uiContext.attachDir = "";
  });

  it("(#89) 「止まっているかも」は、daemon の知らせ（stall）があるときだけ出す（時刻から推し量らない）", () => {
    expect(UI_JS).toContain("if (i.stall === true) {");
    expect(UI_JS).not.toMatch(/lastActivityAt[^\n]*(stall|止まっているかも)/);
  });

  it("(#89) 呼び名は題（整えて切る）。題がなければ ID", () => {
    expect(api.nodeLabel({ id: "a", title: "集計を直す" }, 10)).toBe("集計を直す");
    expect(api.nodeLabel({ id: "a", title: "あ".repeat(20) }, 10)).toBe(`${"あ".repeat(9)}…`);
    expect(api.nodeLabel({ id: "a" }, 10)).toBe("a");
  });

  it("(#89) 動きは CSS の keyframes とクラスだけ。prefers-reduced-motion と「動きを止める」で止まる", () => {
    expect(UI_CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\{\*,\*::before\{animation:none!important;transition:none!important\}/,
    );
    expect(UI_CSS).toContain(
      ".still *,.still *::before{animation:none!important;transition:none!important}",
    );
    // 図の上を動く彗星は、動きを減らす設定と「動きを止める」のとき隠す（線と箱は残る）
    expect(UI_CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\{[^@]*\.comet\{display:none\}\}/,
    );
    expect(UI_CSS).toContain(".still .comet{display:none}");
    expect(UI_JS).toContain("root.classList.toggle('still', x.still)"); // 設定の窓の「動きを止める」（#139）
    expect(UI_JS).not.toMatch(/\.animate\(|requestAnimationFrame/);
  });

  it("(#89) 管理（最終削除・保留・保管）は、管理の窓（dialog）の中にある", () => {
    const admin = UI_HTML.indexOf('<dialog id="admin"');
    expect(admin).toBeGreaterThan(-1);
    expect(UI_HTML.indexOf('id="purge"')).toBeGreaterThan(admin);
    expect(UI_HTML.indexOf('id="kept"')).toBeGreaterThan(admin);
    // 作業の一覧（#todo）は管理の窓の外（窓の閉じタグより後）にある
    const adminEnd = UI_HTML.indexOf("</dialog>", admin);
    expect(UI_HTML.indexOf('id="purge"')).toBeLessThan(adminEnd);
    expect(UI_HTML.indexOf('id="kept"')).toBeLessThan(adminEnd);
    expect(UI_HTML.indexOf('id="todo"')).toBeGreaterThan(adminEnd);
  });

  it("窓の中のボタンの地（--sheet）は、primary・go・done・danger・quiet の地を上書きしない", () => {
    expect(UI_CSS).toContain(
      "dialog.settings button:not(.primary):not(.go):not(.done):not(.danger):not(.quiet)",
    );
    expect(UI_CSS).not.toMatch(/dialog\.settings button,/);
    expect(UI_CSS).toContain("button.primary,button.go{background:var(--kaki)");
  });

  it("管理の窓は、焦点が見出しのときの Shift+Tab も末尾へ回し、閉じたら送る前の確認を取り消す", () => {
    expect(UI_JS).toContain("document.activeElement === box.querySelector('h2')");
    expect(UI_JS).not.toContain("toAdminSwitching");
    expect(UI_JS).toContain(
      "if (pending && pending.fromAdmin && !pending.sending) pending = null;",
    );
  });

  it("確認の出所: 管理の窓が開いている間に出した確認だけに fromAdmin を付け、窓の中に出す。本文の確認は取り消さない", () => {
    expect(UI_JS).toContain("fromAdmin: document.getElementById('admin').open");
    expect(UI_JS).toContain(
      "document.getElementById('admin').open && Boolean(pending && pending.fromAdmin)",
    );
    expect(UI_JS).not.toContain("if (pending && !pending.sending) pending = null;");
  });

  it("(3) 接続できない・取得に失敗したときは、理由と確かめることを言う", () => {
    expect(api.UNREACHABLE_TEXT).toContain("daemon が動いているか");
    expect(api.UNREACHABLE_TEXT).toContain("ポート");
    expect(api.fetchFailureText(429)).toContain("要求が多すぎます");
    expect(api.fetchFailureText(500)).toContain("daemon のログ");
    expect(api.fetchFailureText(404)).toBe("取得に失敗（404）。再試行します");
  });

  it("(1) 確認を開いた直後に、確認の欄まで動かして、フォーカスを欄の中に移す。通知も見える所まで動かす", () => {
    expect(UI_JS).toContain("justOpened: true");
    const body = fnOf("renderConfirm");
    expect(body).toContain("box.scrollIntoView({ block: 'start' })");
    expect(body).toContain("target.focus({ preventScroll: true })");
    expect(fnOf("notice")).toContain("n.scrollIntoView({ block: 'nearest' })");
  });

  it("(2) 打ち込ませる文字列は、1 回のクリックで全体を選べる（コピーして貼り付けられる）", () => {
    expect(fnOf("renderConfirm")).toContain("el('span', 'typed-value', pending.typed)");
    expect(UI_CSS).toMatch(/\.typed-value\{[^}]*user-select:all/);
  });

  it("(5) 入力欄は、すべて id と name を持つ（textarea は field() だけで作る。トークンの欄にも name）", () => {
    expect(UI_JS.split("el('textarea'").length - 1).toBe(1); // field の中の 1 か所だけ
    const body = fnOf("field");
    expect(body).toContain("e.name = fieldName");
    expect(body).toContain("e.id = fieldName + '-' + fieldSeq");
    expect(UI_HTML).toContain('<input id="token" name="token"');
  });
});

describe("関係図の呼び出し（#89 の PR-5）", () => {
  it("app.js が図に触れるのは、window.touryouGraph の draw・destroy だけ。graph.js がなくても一覧で動く", () => {
    const uses = [...UI_JS.matchAll(/touryouGraph\.?(\w*)/g)].map((m) => m[0]);
    expect(uses).toEqual(["touryouGraph"]); // 1 か所で取り出し、そこで形を確かめる
    expect(UI_JS).toContain(
      "typeof g.draw === 'function' && typeof g.destroy === 'function' ? g : null",
    );
    expect([...UI_JS.matchAll(/\bg\.draw\(/g)]).toHaveLength(1);
    expect(UI_JS).toContain("var box = document.getElementById('graph');");
    // 箱を押したときに graph.js から返るのは ID だけ。形を確かめてから、一覧の「詳しく」と同じ openCard を呼ぶ
    expect(UI_JS).toContain(
      "var pick = function (id) { if (typeof id === 'string' && ID_RE.test(id)) openCard(id); };",
    );
    // 描けないとき（reject も同期の例外も）は一覧に戻る。戻すのは、いちばん新しい描きのときだけ
    // 止めた・済んだ子を隠すかどうか（#206）も、設定から draw に渡す
    expect(UI_JS).toContain(
      "Promise.resolve(g.draw(box, view, { onPick: pick, lang: lang, hideFinished: settings.hideFinished })).then(fit, fallback);",
    );
    expect(UI_JS).toMatch(/\} catch \(e\) \{\s*fallback\(\);/);
    expect(UI_JS).toMatch(
      /var fallback = function \(\) \{\s*if \(mine !== graphDrawId\) return;\s*graphMode = 'list';/,
    );
  });
  it("見せ方の切り替え（図・一覧）があり、動きを止める（.still）と OS の設定で、図の動きも止まる", () => {
    expect(UI_HTML).toContain(
      '<button id="show-graph" class="quiet sm" type="button" data-t="view.graph">図</button>',
    );
    expect(UI_HTML).toContain(
      '<button id="show-list" class="quiet sm" type="button" data-t="view.list">一覧</button>',
    );
    expect(UI_CSS).toContain(".still *,.still *::before{animation:none!important");
    expect(UI_CSS).toMatch(
      /prefers-reduced-motion: reduce\)\{\*,\*::before\{animation:none!important/,
    );
    expect(UI_CSS).toContain(".line.g-sent{animation:gflow");
  });
  it("止めた・済んだ子を隠すトグル（#206）: 図のときだけ出る切り替えボタン。押すと設定に残し、図を描き直す。件数の札は図の中に出る", () => {
    expect(UI_HTML).toContain(
      '<button id="hide-finished" class="quiet sm" type="button" aria-pressed="false" data-t="view.hideFinished">止めた・済んだ子を隠す</button>',
    );
    // 切り替えのボタンの欄は、図のときだけ出す（一覧には効かないので、出さない）
    expect(UI_HTML).toMatch(/<div id="graph-filter" class="seg" hidden>/);
    expect(UI_JS).toContain("document.getElementById('graph-filter').hidden = !on;");
    expect(UI_JS).toContain(
      "document.getElementById('hide-finished').ariaPressed = settings.hideFinished ? 'true' : 'false';",
    );
    const at = UI_JS.indexOf("document.getElementById('hide-finished').addEventListener('click'");
    expect(at).toBeGreaterThan(-1);
    const body = UI_JS.slice(at, UI_JS.indexOf("\n  });\n", at));
    expect(body).toContain("settings.hideFinished = !settings.hideFinished;");
    expect(body).toContain("saveSettings(settings);");
    expect(body).toContain("dropGraph();");
    expect(UI_CSS).toContain(".ghidden{");
  });
  it("切り替えボタンと隠した件数の文は、日本語と英語の両方にある（#206）", () => {
    for (const key of ["view.hideFinished", "graph.hidden"] as const) {
      const text = UI_TEXT_TABLE[key];
      expect(text.ja, key).not.toBe("");
      expect(text.en, key).not.toBe("");
      expect(text.en, key).not.toBe(text.ja);
    }
  });
});

describe("カードの状態の札（図の箱と同じ言葉）", () => {
  it("app.js の STATUS_TEXT・RUN_TEXT は、graph-model.ts と同じ言葉（同じ表の鍵。#140）", async () => {
    const { STATUS_TEXT, RUN_TEXT } = await import("../../src/ui/graph-model.js");
    const pick = (name: string): Record<string, string> => {
      const m = new RegExp(`var ${name} = (\\{[^\\n]*\\});`).exec(UI_JS);
      if (m === null) throw new Error(name);
      return Function(`return (${m[1]})`)() as Record<string, string>;
    };
    expect(pick("STATUS_TEXT")).toEqual(STATUS_TEXT);
    expect(pick("RUN_TEXT")).toEqual(RUN_TEXT);
  });
});

describe("状態変化の読み上げ・スマホの幅（UI レビューの対応）", () => {
  const fnOf = (name: string): string => {
    const i = UI_JS.indexOf(`  function ${name}(`);
    expect(i, name).toBeGreaterThan(-1);
    return UI_JS.slice(i, UI_JS.indexOf("\n  }\n", i) + 5);
  };

  it("図の箱は role=button で、Tab で移れる（束 graph.js の中）", () => {
    expect(UI_GRAPH_JS).toMatch(/\.role="button"/);
    expect(UI_GRAPH_JS).toMatch(/\.tabIndex=0/);
  });

  it("読み上げは live.wait・live.fail・live.lost の 3 つだけ（ほかに、写すボタンの結果だけ）。最初の描画では読まない", () => {
    for (const key of ["live.wait", "live.fail", "live.lost"]) {
      expect(UI_JS, key).toContain(`t('${key}'`);
    }
    const keys = [...UI_JS.matchAll(/said\.push\(t\('([^']+)'/g)].map((m) => m[1]);
    expect(keys).toEqual(["live.wait", "live.fail"]);
  });

  it("render の読み上げ: 最初の描画では読まず、増えたときだけ読み、同じなら読まない。rejectToken のあとは最初に戻る", () => {
    const announced: string[] = [];
    const ctx = {
      __announce: (m: string) => announced.push(m),
      __cur: { wait: 0, statuses: [] as { status: string }[] },
    };
    const api = runInNewContext(
      [
        "var lastCount = -1; var lastFail = -1; var lostSaid = true; var lastView = null; var lastRaw = null;",
        "var attachDir = ''; var titleById = null; var nextSeen = null; var cardStatus = null; var graphView = null; var seenItems = null;",
        "var viaSession = false; var token = 't'; var etag = ''; var generation = 0; var sseUp = false; var keptList = null;",
        "var purgeSignature = null; var pending = null; var controller = null;",
        "var codeDrafts = new Map(); var approvalErrors = new Map();",
        "var document = { activeElement: null, getElementById: function () { return {}; } };",
        "function t(k) { return k; }",
        "function announce(m) { __announce(m); }",
        "function renderApprovals() {}",
        // render は view の一部だけを v に写すので、試験の値は ctx.__cur から読む
        "function renderTodo() { lastCount = __cur.wait; }",
        "function statusesOf() { return __cur.statuses; }",
        "function renderCards() {}",
        "function renderList() { return 0; }",
        "function renderGraph() {}",
        "function renderPurge() {}",
        "function renderPolicy() {}",
        "function showAuth() {}",
        "function showConnected() {}",
        "function setStatus() {}",
        "function dropGraph() {}",
        fnOf("render"),
        fnOf("rejectToken"),
        "({ render: render, rejectToken: rejectToken })",
      ].join("\n"),
      ctx,
    ) as { render(view: unknown): void; rejectToken(m: string): void };
    const view = (wait: number, fail: number) => {
      ctx.__cur = { wait, statuses: Array.from({ length: fail }, () => ({ status: "fail" })) };
      return {
        nodes: [],
        inbox: [],
        decisions: [],
        extensions: [],
        flows: [],
        confirmations: [],
        truncated: [],
        lastSeq: 1,
      };
    };
    api.render(view(3, 1));
    expect(announced).toEqual([]); // 前が -1（最初の描画）
    api.render(view(5, 2));
    expect(announced).toEqual(["live.wait。live.fail"]); // 増えた
    api.render(view(5, 2));
    expect(announced).toHaveLength(1); // 同じ
    api.rejectToken("x");
    api.render(view(9, 4));
    expect(announced).toHaveLength(1); // rejectToken のあとは、最初の描画に戻る
  });

  it("接続が切れた読み上げは、取得に成功したあと（304 の変わりなしも）に、2 回目も読み上げる", () => {
    const announced: string[] = [];
    let next = 0;
    const responses = [
      { status: 503, ok: false },
      { status: 503, ok: false }, // 続けて失敗しても、読み上げは 1 回だけ
      { status: 304, ok: false }, // 変わりなしでも、取得に成功したので、戻す
      { status: 503, ok: false }, // 2 回目の切れ
      { status: 200, ok: true }, // 描けるほどの成功でも、戻す
      { status: 503, ok: false }, // 3 回目の切れ
    ];
    const ctx = {
      __announce: (m: string) => announced.push(m),
      __fetch: () =>
        Promise.resolve({
          ...responses[next++],
          headers: { get: () => '"e"' },
          json: () => Promise.resolve({ ok: true, value: {} }),
        }),
    };
    const api = runInNewContext(
      [
        "var token = 't'; var etag = ''; var lastView = { seq: 1 }; var lostSaid = false;",
        "function t(k) { return k; }",
        "function announce(m) { __announce(m); }",
        "function fetch() { return __fetch(); }",
        "function setStatus() {}",
        "function rejectToken() {}",
        "function render() {}",
        "function unreachableText() { return 'u'; }",
        "function fetchFailureText(s) { return 'f' + s; }",
        fnOf("connectionLost"),
        fnOf("fetchState"),
        "({ fetchState: fetchState })",
      ].join("\n"),
      ctx,
    ) as { fetchState(): Promise<void> };
    return (async () => {
      for (let i = 0; i < responses.length; i += 1) await api.fetchState();
      expect(announced).toEqual(["live.lost", "live.lost", "live.lost"]);
    })();
  });

  it("スマホの幅: 小さいボタンは 44px。図のボタンは top 4px で、下端が FIT_TOP に収まる", () => {
    const mobile = /@media \(max-width:640px\)\{([^\n]*)\}\n?$/m.exec(UI_CSS)?.[1] ?? "";
    expect(mobile, "スマホ幅の @media が取れない").not.toBe("");
    expect(mobile).toContain(
      "button.sm,button.copy,button.gear,.settings .policy-add select,.settings .policy-add input{min-height:44px}",
    );
    expect(mobile).toContain(".zoom button{min-width:44px;min-height:44px}");
    const top = Number(/\.zoom\{top:(\d+)px\}/.exec(mobile)?.[1]);
    const src = readFileSync(new URL("../../src/ui/graph-entry.ts", import.meta.url), "utf8");
    const fitTop = Number(/const FIT_TOP = (\d+);/.exec(src)?.[1]);
    expect(top).toBe(4);
    expect(top + 44).toBeLessThanOrEqual(fitTop);
  });
});

describe("受信箱の項目の片付け・戻し（#99）", () => {
  it("画面の片付けられる種類は、core の HUMAN_RESOLVABLE_KINDS と同じ（進み具合・完了・お知らせだけ）", () => {
    const m = /var CLEARABLE_KINDS = \{([^}]*)\};/.exec(UI_JS);
    const kinds = [...(m?.[1] ?? "").matchAll(/(\w+): true/g)].map((x) => x[1]).sort();
    expect(kinds).toEqual([...HUMAN_RESOLVABLE_KINDS].sort());
  });

  it("停止未完了（stall）の項目と、ID の形が不正な項目には、ボタンを付けない", () => {
    expect(UI_JS).toMatch(
      /function isClearable\(i\) \{ return Object\.hasOwn\(CLEARABLE_KINDS, i\.kind\) && i\.stall !== true && ID_RE\.test\(i\.id\); \}/,
    );
  });

  it("「片付けた項目」の欄は view.resolved から作り、ボタンの読み上げの名前に項目の文を添える", () => {
    expect(UI_JS).toContain("resolved-");
    expect(UI_JS).toMatch(/\.resolved\b/);
    expect(UI_JS).toMatch(/b\.ariaLabel = label \+ ': '/);
    expect(UI_JS).toMatch(/undo\.ariaLabel = t\('reopen\.button'\) \+ ': '/);
  });
});
