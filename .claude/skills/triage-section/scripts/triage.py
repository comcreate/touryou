#!/usr/bin/env python3
"""見回り係の見立てを出す（何を片付け、何を候補として知らせるか）。片付けそのものはしない。

使い方:
  python3 triage.py plan          見立てを JSON で出す（状態のファイルを更新する）
  python3 triage.py done <名前>   片付けたものを、印と状態から外す

対象にするのは、背景のセッション（kind が background）で、名前が作業の頭（既定 orch-work-）で始まるものだけ。
統括・常駐の手伝い・touryou の子（node-…）・対話のセッションには触らない。
置き場（既定 $HOME/touryou-orch）と名前の頭は、section-launcher の orch_config.py の設定（環境変数・config.json）で変えられる。

- 印: <置き場>/archive-ok.txt（統括が、片付けてよい名前を 1 行に 1 つ書く。# で始まる行と空行は読まない）
- 状態: <置き場>/triage-state.json（見回りで最後に動いているのを見た時刻など。鍵は sessionId）

claude agents --json の背景のセッションには、claude stop・claude rm に渡す短い id（8 桁）と、
--resume に渡す sessionId がある。プロセスが動いているものにだけ pid が付く。
id のないものは、片付けずに waiting に入れる。

「動いていない時間」は、見回りが最後に busy を見た時刻と、最初に見つけた時刻の遅いほうから数える。
見回りが見ていない間の動きは分からないので、見つけてから 1 時間（片付け）・24 時間（候補）は、必ず待つ。
"""
import importlib.util
import json
import os
import subprocess
import sys
import time

# clone の中に __pycache__ を作らない（git status を汚さないため）
sys.dont_write_bytecode = True

# 置き場と名前は、section-launcher の orch_config.py の設定から決める（既定: $HOME/touryou-orch・orch-work-）。
_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "orch_config", os.path.join(_HERE, "..", "..", "section-launcher", "scripts", "orch_config.py"))
_orch_config = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_orch_config)
_CFG = _orch_config.load()

BASE = _CFG["dir"]
STATE = os.path.join(BASE, "triage-state.json")
MARKS = os.path.join(BASE, "archive-ok.txt")
PREFIX = _CFG["names"]["workPrefix"]
HOUR_MS = 60 * 60 * 1000
ARCHIVE_AFTER_MS = 1 * HOUR_MS
CANDIDATE_AFTER_MS = 24 * HOUR_MS
REPORT_AGAIN_MS = 24 * HOUR_MS
MARKS_HEAD = f"# 片付けてよい背景のセッションの名前（{PREFIX} で始まるもの）を、1 行に 1 つ書く。名前は使い回さない\n"


def agents(include_done):
    cmd = ["claude", "agents", "--json"] + (["--all"] if include_done else [])
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=120, check=True).stdout
    data = json.loads(out)
    if not isinstance(data, list):
        raise SystemExit("claude agents --json の形が、思っていたもの（配列）と違います。止めます")
    return [e for e in data if isinstance(e, dict)]


def load_state():
    """読めない・形が違うときは、.bad に名前を変えて、空から始める（毎時の失敗を続けないため）。"""
    try:
        with open(STATE, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        data = None
    if not isinstance(data, dict):
        try:
            os.replace(STATE, STATE + ".bad")
        except OSError:
            pass
        return {}
    return {k: v for k, v in data.items() if isinstance(v, dict)}


def save_state(value):
    os.makedirs(BASE, exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE)


def load_marks():
    try:
        with open(MARKS, encoding="utf-8") as f:
            return [ln.strip() for ln in f if ln.strip() and not ln.strip().startswith("#")]
    except FileNotFoundError:
        return []


def num(x, default=0):
    return x if isinstance(x, (int, float)) else default


def plan():
    now = int(time.time() * 1000)
    state = load_state()
    marks = set(load_marks())
    seen = set()
    archive, candidates, waiting = [], [], []
    for e in agents(True):
        sid, name = e.get("sessionId"), e.get("name") or ""
        if not isinstance(sid, str) or not sid or e.get("kind") != "background" or not name.startswith(PREFIX):
            continue
        seen.add(sid)
        s = state.setdefault(sid, {})
        s["name"] = name
        s.setdefault("firstSeenAt", now)
        if e.get("status") == "busy":
            s["lastBusyAt"] = now
            continue
        quiet_ms = now - max(num(s.get("lastBusyAt")), num(s.get("firstSeenAt"), now))
        quiet_h = round(quiet_ms / HOUR_MS, 1)
        short_id = e.get("id")
        if name in marks:
            if not isinstance(short_id, str) or not short_id:
                waiting.append({"name": name, "reason": "印はあるが、claude stop・rm に渡す id が一覧にない", "quietHours": quiet_h})
            elif quiet_ms >= ARCHIVE_AFTER_MS:
                archive.append({"name": name, "id": short_id, "running": e.get("pid") is not None, "quietHours": quiet_h})
            else:
                waiting.append({"name": name, "reason": "印はあるが、見回りで最後に動いているのを見てから 1 時間に届いていない", "quietHours": quiet_h})
        elif quiet_ms >= CANDIDATE_AFTER_MS and now - num(s.get("reportedAt")) >= REPORT_AGAIN_MS:
            candidates.append({"name": name, "quietHours": quiet_h})
            s["reportedAt"] = now
    for sid in [k for k in state if k not in seen]:
        del state[sid]
    save_state(state)
    print(json.dumps({"archive": archive, "candidates": candidates, "waiting": waiting}, ensure_ascii=False, indent=2))


def done(name):
    marks = [m for m in load_marks() if m != name]
    os.makedirs(BASE, exist_ok=True)
    tmp = MARKS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(MARKS_HEAD)
        for m in marks:
            f.write(m + "\n")
    os.replace(tmp, MARKS)
    state = load_state()
    for sid in [k for k, v in state.items() if v.get("name") == name]:
        del state[sid]
    save_state(state)
    print(f"{name} を、印と状態から外しました")


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "plan":
        plan()
    elif len(sys.argv) == 3 and sys.argv[1] == "done":
        done(sys.argv[2])
    else:
        print(__doc__)
        sys.exit(2)
