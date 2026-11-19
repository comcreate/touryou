#!/usr/bin/env python3
"""統括の常駐の手伝い（背景のセッション）を、設定から組み立てて立てる・起こす・止める。

使い方（統括のセッションで、touryou の clone の中から）:
  python3 launch.py status                         4 つの手伝いのようす（動いている・止まっている・ない）
  python3 launch.py start <役目> [--model M] [--effort E]   新しく立てる（triage・board・review-ui・review-ux）
  python3 launch.py resume <役目>                  止まっているものを、前の会話のまま起こす
  python3 launch.py stop <役目>                    動いているものを止める（会話は残る）
  python3 launch.py work <題> <指示のファイル>      作業のセッションを、作業ツリーを分けて立てる

- 名前・権限のモード・置き場は、orch_config.py の設定から決める（既定: orch-root・orch-triage…・auto・$HOME/touryou-orch）。
- コマンドは、シェルを通さずに引数の並びで渡す（名前や指示の文の引用で壊れないため）。
- セッションの ID は、コマンドの中でだけ使い、出力に出さない。
- 背景のセッションは、統括と同じ clone（この script のある checkout）で立てる。
"""
import importlib.util
import json
import os
import re
import subprocess
import sys

# clone の中に __pycache__ を作らない（git status を汚さないため）
sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("orch_config", os.path.join(HERE, "orch_config.py"))
orch_config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(orch_config)

ROLES = {
    "triage": ("triage", "見回り係", "triage-section"),
    "board": ("board", "ボード係", "board-updator"),
    "review-ui": ("reviewUi", "UI レビュー係", "review-ui"),
    "review-ux": ("reviewUx", "UX レビュー係", "review-ux"),
}
SETTINGS = json.dumps({"crossSessionInbound": "accept"})
SLUG = r"^[a-z0-9][a-z0-9-]{0,40}$"


def repo_root():
    out = subprocess.run(["git", "-C", HERE, "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True)
    return out.stdout.strip()


def agents():
    out = subprocess.run(["claude", "agents", "--json", "--all"], capture_output=True, text=True, timeout=120, check=True)
    data = json.loads(out.stdout)
    if not isinstance(data, list):
        raise SystemExit("claude agents --json の形が、思っていたもの（配列）と違います。止めます")
    return [e for e in data if isinstance(e, dict)]


def sessions_named(name):
    return sorted((e for e in agents() if e.get("name") == name), key=lambda e: e.get("startedAt") or 0)


def alive(e):
    return e.get("pid") is not None


def launch_prompt(cfg, role):
    key, label, skill = ROLES[role]
    me, root = cfg["names"][key], cfg["names"]["root"]
    return (
        f"あなたは touryou の統括の常駐の手伝い「{label}（{me}）」です。"
        f"最初に {skill} の skill を使い、その「始めるとき」の手順から進めてください。"
        f"統括（親）の名前は {root} です。"
    )


def run_bg(args, cwd):
    r = subprocess.run(["claude", *args], cwd=cwd, capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        tail = (r.stderr or r.stdout).strip().splitlines()[-3:]
        raise SystemExit("claude が失敗しました: " + " / ".join(tail))


def cmd_status(cfg):
    names = cfg["names"]
    rows = []
    for role, (key, label, _) in ROLES.items():
        found = sessions_named(names[key])
        if not found:
            state = "ない"
        elif any(alive(e) for e in found):
            state = "動いている"
        else:
            state = "止まっている"
        dup = "（同じ名前が複数）" if len([e for e in found if alive(e)]) > 1 else ""
        rows.append(f"{names[key]}\t{label}\t{state}{dup}")
    roots = [e for e in agents() if e.get("name") == names["root"] and e.get("kind") == "interactive" and alive(e)]
    rows.append(f"{names['root']}\t統括\t動いている対話のセッション {len(roots)} 個（1 個が正しい）")
    print("\n".join(rows))


def cmd_start(cfg, role, extra):
    key = ROLES[role][0]
    name = cfg["names"][key]
    found = sessions_named(name)
    if any(alive(e) for e in found):
        raise SystemExit(f"{name} は、もう動いています。立てません")
    if found:
        raise SystemExit(f"{name} は止まっています。新しく立てずに resume で起こしてください")
    args = ["--bg", launch_prompt(cfg, role), "--name", name, *extra,
            "--permission-mode", cfg["permissionMode"], "--add-dir", cfg["dir"], "--settings", SETTINGS]
    os.makedirs(cfg["dir"], exist_ok=True)
    run_bg(args, repo_root())
    print(f"立てました: {name}（起動しました、の知らせを待ってください）")


def cmd_resume(cfg, role):
    name = cfg["names"][ROLES[role][0]]
    found = sessions_named(name)
    if any(alive(e) for e in found):
        raise SystemExit(f"{name} は動いています。起こす必要はありません")
    if not found or not found[-1].get("sessionId"):
        raise SystemExit(f"{name} の止まった会話が見つかりません。start で新しく立ててください")
    run_bg(["--bg", "--resume", found[-1]["sessionId"]], repo_root())
    print(f"起こしました: {name}（予定を作り直すよう、知らせを送ってください）")


def cmd_stop(cfg, role):
    name = cfg["names"][ROLES[role][0]]
    live = [e for e in sessions_named(name) if alive(e) and e.get("id")]
    if not live:
        raise SystemExit(f"{name} は動いていません")
    r = subprocess.run(["claude", "stop", live[-1]["id"]], capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise SystemExit(f"{name} を止められませんでした")
    print(f"止めました: {name}（会話は残っています。resume で起こせます）")


def cmd_work(cfg, slug, prompt_file):
    if not re.fullmatch(SLUG, slug):
        raise SystemExit("題は、英小文字・数字・- だけで書いてください（例: review-154-1）")
    name = cfg["names"]["workPrefix"] + slug
    if sessions_named(name):
        raise SystemExit(f"{name} という名前は、もう使われています。番号を変えてください（名前は使い回さない）")
    with open(prompt_file, encoding="utf-8") as f:
        prompt = f.read().strip()
    if not prompt:
        raise SystemExit("指示のファイルが空です")
    args = ["--bg", prompt, "--name", name, "-w", name,
            "--permission-mode", cfg["permissionMode"], "--add-dir", cfg["dir"], "--settings", SETTINGS]
    run_bg(args, repo_root())
    print(f"立てました: {name}")


def main(argv):
    cfg = orch_config.load()
    if len(argv) >= 1 and argv[0] == "status":
        return cmd_status(cfg)
    if len(argv) >= 2 and argv[0] in ("start", "resume", "stop") and argv[1] in ROLES:
        if argv[0] == "start":
            extra, rest = [], argv[2:]
            while rest:
                if rest[0] in ("--model", "--effort") and len(rest) >= 2 and re.fullmatch(r"[A-Za-z0-9._\[\]-]{1,64}", rest[1]):
                    extra += rest[:2]
                    rest = rest[2:]
                else:
                    raise SystemExit("start に渡せるのは --model と --effort だけです")
            return cmd_start(cfg, argv[1], extra)
        return cmd_resume(cfg, argv[1]) if argv[0] == "resume" else cmd_stop(cfg, argv[1])
    if len(argv) == 3 and argv[0] == "work":
        return cmd_work(cfg, argv[1], argv[2])
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]) or 0)
