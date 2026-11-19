#!/usr/bin/env python3
"""統括の手伝い（section-launcher などの skill）の設定を読み、既定を補って出す。

使い方:
  python3 orch_config.py             すべての設定を JSON で出す（problems に、読めなかった所を出す）
  python3 orch_config.py --get <鍵>  1 つの値だけを出す（例: --get ghUser、--get names.board）

設定の置き場（上のほうが勝つ）:
  1. 環境変数: TOURYOU_ORCH_REPO・TOURYOU_ORCH_GH_USER・TOURYOU_ORCH_BOARD_URL・TOURYOU_ORCH_NAME_PREFIX・
     TOURYOU_ORCH_PERMISSION_MODE・TOURYOU_ORCH_TRIAGE_CRON・TOURYOU_ORCH_BOARD_CRON
  2. 設定のファイル: ${TOURYOU_ORCH_CONFIG:-${TOURYOU_ORCH_DIR:-$HOME/touryou-orch}/config.json}
  3. 既定（DEFAULTS）

値は、コマンドの引数や背景のセッションの名前に入るので、形を確かめる。形が違う値は使わずに既定に戻し、problems に書く。
個人の値（gh のアカウント・ボードの URL）は、この設定にだけ置き、リポジトリには書かない。
"""
import json
import os
import re
import sys

DEFAULTS = {
    "repo": "comcreate/touryou",
    "ghUser": "",
    "boardUrl": "",
    "namePrefix": "orch-",
    "permissionMode": "auto",
    "triageCron": "41 * * * *",
    "boardCron": "15 * * * *",
}

ENV = {
    "repo": "TOURYOU_ORCH_REPO",
    "ghUser": "TOURYOU_ORCH_GH_USER",
    "boardUrl": "TOURYOU_ORCH_BOARD_URL",
    "namePrefix": "TOURYOU_ORCH_NAME_PREFIX",
    "permissionMode": "TOURYOU_ORCH_PERMISSION_MODE",
    "triageCron": "TOURYOU_ORCH_TRIAGE_CRON",
    "boardCron": "TOURYOU_ORCH_BOARD_CRON",
}

CRON = r"^[0-9*/,-]+( [0-9*/,-]+){4}$"
PATTERNS = {
    "repo": r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
    "ghUser": r"^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))?$",
    "boardUrl": r"^(https://claude\.ai/(code/)?artifact/[A-Za-z0-9_-]+)?$",
    "namePrefix": r"^[a-z0-9][a-z0-9-]{0,20}$",
    # bypassPermissions は許さない（手元の設定だけで、手伝いと作業のセッションが確かめなしに動くようになるため）
    "permissionMode": r"^(acceptEdits|auto|manual|dontAsk|plan)$",
    "triageCron": CRON,
    "boardCron": CRON,
}

ROLES = {
    "root": "root",
    "triage": "triage",
    "board": "board",
    "reviewUi": "review-ui",
    "reviewUx": "review-ux",
}


def orch_dir():
    return os.environ.get("TOURYOU_ORCH_DIR") or os.path.join(os.environ["HOME"], "touryou-orch")


def config_path():
    return os.environ.get("TOURYOU_ORCH_CONFIG") or os.path.join(orch_dir(), "config.json")


def load():
    problems = []
    data = {}
    path = config_path()
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
        if isinstance(raw, dict):
            data = raw
        else:
            problems.append("設定のファイルの中身がオブジェクトでないので、使わずに既定で動く")
    except FileNotFoundError:
        problems.append("設定のファイルがないので、既定で動く")
    except (OSError, ValueError):
        problems.append("設定のファイルが JSON として読めないので、使わずに既定で動く")

    cfg = {}
    for key, default in DEFAULTS.items():
        value, source = default, "既定"
        if isinstance(data.get(key), str):
            value, source = data[key], "設定のファイル"
        env = os.environ.get(ENV[key])
        if env is not None:
            value, source = env, "環境変数 " + ENV[key]
        if not re.fullmatch(PATTERNS[key], value):
            problems.append(f"{key} の形が違うので（{source}）、既定を使う")
            value = default
        cfg[key] = value

    prefix = cfg["namePrefix"]
    names = {k: prefix + v for k, v in ROLES.items()}
    names["workPrefix"] = prefix + "work-"
    if not cfg["ghUser"]:
        problems.append("ghUser がないので、gh はいまの認証のまま使う（gh auth switch をしない）")
    if not cfg["boardUrl"]:
        problems.append("boardUrl がないので、ボード係はボードを直せない（作るかを統括に聞く）")
    return {
        "dir": orch_dir(),
        "config": path,
        **cfg,
        "names": names,
        "problems": problems,
    }


def get(cfg, dotted):
    cur = cfg
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            raise SystemExit(f"知らない鍵です: {dotted}")
        cur = cur[part]
    if isinstance(cur, (dict, list)):
        return json.dumps(cur, ensure_ascii=False)
    return str(cur)


if __name__ == "__main__":
    cfg = load()
    if len(sys.argv) == 1:
        print(json.dumps(cfg, ensure_ascii=False, indent=2))
    elif len(sys.argv) == 3 and sys.argv[1] == "--get":
        print(get(cfg, sys.argv[2]))
    else:
        print(__doc__)
        sys.exit(2)
