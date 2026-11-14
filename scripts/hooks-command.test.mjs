// plugin/hooks/hooks.json の command（scripts/hook-commands.mjs）を、実際にシェルで走らせて確かめる試験。`node --test scripts/*.test.mjs`
// Claude Code は、macOS・Linux では、command の文字列を `sh -c` で実行する（公式の hooks のドキュメント）。macOS の sh は bash の POSIX モード、
// Linux の多くは dash なので、`sh -c` と `bash --posix -c`（あれば）の両方で走らせる。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { HOOK_COMMAND_GUARD, HOOK_COMMAND_PASSIVE, HOOK_COMMANDS } from "./hook-commands.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const hasBash = spawnSync("bash", ["--version"]).status === 0;
const SHELLS = [["sh", ["-c"]], ...(hasBash ? [["bash", ["--posix", "-c"]]] : [])];

/** 仮の HOME。`content` が undefined なら、スタブ（引数と標準入力を出力して、STUB_EXIT で終了）。`stub: false` なら、`touryou` を置かない。 */
const home = ({ stub = true, executable = true, name = "h", content } = {}) => {
  const base = mkdtempSync(join(tmpdir(), "touryou-hooks-"));
  made.push(base);
  const h = join(base, name);
  mkdirSync(join(h, ".touryou", "v1", "touryou-darwin-arm64", "bin"), { recursive: true });
  if (stub) {
    const f = join(h, ".touryou", "v1", "touryou-darwin-arm64", "bin", "touryou");
    writeFileSync(f, content ?? '#!/bin/sh\necho "STUB args=$*"\ncat\nexit "${STUB_EXIT:-0}"\n');
    chmodSync(f, executable ? 0o755 : 0o644);
    symlinkSync(join(h, ".touryou", "v1", "touryou-darwin-arm64"), join(h, ".touryou", "current"));
  }
  return h;
};

const run = (command, env, input = '{"hook_event_name":"PreToolUse"}', shell = SHELLS[0]) =>
  spawnSync(shell[0], [...shell[1], command], {
    input,
    // PATH は、sh の最小限だけ（touryou が PATH にあっても、見ないこと・ほかのコマンドに頼らないことの確認）
    env: { PATH: "/usr/bin:/bin", ...env },
    encoding: "utf8",
  });
const CHILD = { TOURYOU_NODE_TOKEN: "t".repeat(16), TOURYOU_DAEMON_URL: "http://127.0.0.1:1" };
const isGuard = (c) => c === HOOK_COMMAND_GUARD;

test("hooks.json は、定数と完全一致（PreToolUse は拒否版、PostToolUse・Stop・Notification は止めない版、SessionStart は版の知らせ）", () => {
  const j = JSON.parse(readFileSync(join(root, "plugin", "hooks", "hooks.json"), "utf8"));
  for (const [event, command] of Object.entries(HOOK_COMMANDS)) {
    assert.equal(j.hooks[event][0].hooks[0].command, command, event);
  }
  assert.equal(Object.keys(j.hooks).length, 5);
});

test("command に、単一引用符・バッククォートが入らない。`exec` を使わない（壊れた touryou で、シェルごと終了するため）", () => {
  for (const c of Object.values(HOOK_COMMANDS)) {
    assert.doesNotMatch(c, /['`]/);
    assert.doesNotMatch(c, /\bexec\b/);
  }
});

for (const shell of SHELLS) {
  for (const [label, command] of [
    ["拒否版", HOOK_COMMAND_GUARD],
    ["止めない版", HOOK_COMMAND_PASSIVE],
  ]) {
    const t = (name, fn) => test(`[${shell[0]}] ${label}: ${name}`, fn);

    t(
      "① touryou が実行可能なら、実行され、引数は hook、標準入力が渡る。終了コード 0・2 は、そのまま（止めない版は 0）",
      () => {
        const h = home();
        const r0 = run(command, { HOME: h, STUB_EXIT: "0" }, "入力の本文", shell);
        assert.equal(r0.status, 0);
        assert.match(r0.stdout, /STUB args=hook\n入力の本文/);
        const r2 = run(command, { HOME: h, STUB_EXIT: "2" }, "x", shell);
        assert.equal(r2.status, isGuard(command) ? 2 : 0);
      },
    );

    t("② 未配置・環境変数なし → 終了コード 0 と、標準エラーに一言", () => {
      const h = home({ stub: false });
      const r = run(command, { HOME: h }, undefined, shell);
      assert.equal(r.status, 0);
      assert.match(r.stderr, /フックは働いていない/);
    });

    t("④ 未配置で、片方だけ・空文字 → 素通し（0）", () => {
      const h = home({ stub: false });
      for (const env of [
        { TOURYOU_NODE_TOKEN: "x" },
        { TOURYOU_DAEMON_URL: "http://127.0.0.1:1" },
        { TOURYOU_NODE_TOKEN: "", TOURYOU_DAEMON_URL: "http://127.0.0.1:1" },
        { TOURYOU_NODE_TOKEN: "x", TOURYOU_DAEMON_URL: "" },
        { TOURYOU_NODE_TOKEN: "", TOURYOU_DAEMON_URL: "" },
      ]) {
        assert.equal(
          run(command, { HOME: h, ...env }, undefined, shell).status,
          0,
          JSON.stringify(env),
        );
      }
    });

    t("⑤ HOME が未設定・空 → 未配置と同じ（ルート直下の .touryou を、探さない）", () => {
      assert.equal(run(command, {}, undefined, shell).status, 0);
      assert.equal(run(command, { HOME: "" }, undefined, shell).status, 0);
      const r = run(command, { HOME: "", ...CHILD }, undefined, shell);
      assert.equal(r.status, isGuard(command) ? 2 : 0);
    });

    t("⑥ 実行権がない → 未配置と同じ", () => {
      const h = home({ executable: false });
      assert.equal(run(command, { HOME: h }, undefined, shell).status, 0);
      assert.equal(
        run(command, { HOME: h, ...CHILD }, undefined, shell).status,
        isGuard(command) ? 2 : 0,
      );
    });

    t("⑦ HOME にスペースが入っていても動く", () => {
      const h = home({ name: "with space" });
      const r = run(command, { HOME: h }, "x", shell);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /STUB args=hook/);
    });

    t(
      "⑧ 標準入力を読まない分岐（未配置）で、大きな入力でも、終了コードも標準エラーも変わらない（EPIPE なし）",
      () => {
        const h = home({ stub: false });
        const small = run(command, { HOME: h }, "x", shell);
        const big = run(command, { HOME: h }, "x".repeat(3 * 1024 * 1024), shell);
        assert.equal(big.status, 0);
        assert.equal(big.stderr, small.stderr);
      },
    );

    t("PATH に touryou があっても、見ない（固定の 1 か所だけ）", () => {
      const h = home({ stub: false });
      const bin = mkdtempSync(join(tmpdir(), "touryou-path-"));
      made.push(bin);
      writeFileSync(join(bin, "touryou"), '#!/bin/sh\necho "PATH の touryou"\nexit 0\n', {
        mode: 0o755,
      });
      const r = spawnSync(shell[0], [...shell[1], command], {
        input: "x",
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: h },
        encoding: "utf8",
      });
      assert.doesNotMatch(r.stdout, /PATH の touryou/);
      assert.match(r.stderr, /フックは働いていない/);
    });

    // フェイルオープンの穴: 壊れた（+x だが実行できない）touryou で、シェルごと終了コード 126・127 で終わってはいけない
    const broken = [
      ["中身が壊れた +x のファイル（garbage だけ）", "garbage\n"],
      ["アーキテクチャ違い・実行できない形式（ELF の先頭だけ）", "\x7fELF\x02\x01\x01\x00garbage"],
      ["存在しないインタプリタの shebang", "#!/nonexistent/interpreter\necho hi\n"],
      ["シグナルで終了（終了コード 137）", "#!/bin/sh\nexit 137\n"],
      ["終了コード 1（touryou hook は、1 を返さない）", "#!/bin/sh\nexit 1\n"],
      ["終了コード 126", "#!/bin/sh\nexit 126\n"],
      ["終了コード 127", "#!/bin/sh\nexit 127\n"],
    ];
    for (const [what, content] of broken) {
      t(
        `壊れた touryou（${what}）: 子の環境変数が両方あれば、拒否版は 2、止めない版は 0。なければ 0（一言）`,
        () => {
          const h = home({ content });
          const withChild = run(command, { HOME: h, ...CHILD }, undefined, shell);
          assert.equal(withChild.status, isGuard(command) ? 2 : 0, withChild.stderr);
          if (isGuard(command)) assert.match(withChild.stderr, /動かない/);
          const plain = run(command, { HOME: h }, undefined, shell);
          assert.equal(plain.status, 0, plain.stderr);
        },
      );
    }
  }

  test(`[${shell[0]}] ③ 未配置で、子の環境変数が両方ある → 拒否版は終了コード 2（理由つき）、止めない版は 0（Stop が詰まらない）`, () => {
    const h = home({ stub: false });
    const guard = run(HOOK_COMMAND_GUARD, { HOME: h, ...CHILD }, undefined, shell);
    assert.equal(guard.status, 2);
    assert.match(guard.stderr, /拒否: touryou が見つからない/);
    assert.match(guard.stderr, /setup/);
    assert.doesNotMatch(guard.stderr, new RegExp(CHILD.TOURYOU_NODE_TOKEN));
    const passive = run(HOOK_COMMAND_PASSIVE, { HOME: h, ...CHILD }, undefined, shell);
    assert.equal(passive.status, 0);
  });
}
