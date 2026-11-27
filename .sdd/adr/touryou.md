---
id: "adr-touryou"
title: "touryou 決定ログ"
type: "adr"
status: "approved"
sdd-phase: "implement"
created: "2026-11-11"
updated: "2026-11-27"
depends-on: ["spec-touryou"]
tags: ["claude-code", "mcp", "orchestration"]
category: "developer-tooling"
---

# TouRyou 決定ログ

未解決の課題は [open-issues.md](../task/touryou-open-issues/open-issues.md) にある。

## 2026-11-11 セッションを起動せず親のセッションに依頼する

- **Decision**: システムは子のセッションを起動・停止・削除しない。CLI では親のセッションが Bash で `claude --bg`（子ごとにフォークも選べる）・`claude stop`・`claude rm` を実行し、システムは依頼・紐付け・結果の確かめ（作業ツリーのプロセスの確認など）だけを行う。Desktop では人間が子を開き、システムが紐付ける。
- **Rationale**: セッションの起動はいつも Claude Code または Claude Desktop が行い、システムは親子の関係を管理して依頼するだけ、とした。システムが起動しなければ、Anthropic の認証を扱わずに済む。親の Bash から起動・フォーク・停止・削除ができ、裏のセッションも plugin を読む。旧い形との互換は持たない。
- **Rejected alternatives**: Claude Agent SDK（`query()`）でシステムが起動・制御する形 — 子に認証を渡す必要があり、公式の決まり（資格情報を保存・仲介しない）に触れうる。Agent teams — 入れ子にできず、実験的な機能。

## 2026-11-11 Anthropic の認証を扱わない

- **Decision**: システムは API キー・長寿命のトークン・ログインを扱わず、子は起動する Claude Code・Claude Desktop の利用者の認証で動く（NFR_013）。子の HOME の隔離、setup-token の案内、子用の HTTP の MCP の常駐、子の MCP の stdio の中継は持たない。
- **Rationale**: Claude Console の API キーは使えない前提で、認証を扱わないと決めた。システムが起動しないので、認証を渡す相手がない。システムの中だけの資格情報（紐付けで得る子ごとのトークン）は、引き続き相手を確かめてから送る（NFR_005）。
- **Rejected alternatives**: setup-token を子に渡す — 1 年有効で、公式に取り消しの手順がなく、保存・仲介の決まりに触れうる。子の HOME を引き継ぐ — トークンは要らないが、システムが起動する形は残り、隔離も弱まる。

## 2026-11-11 呼び出しは一方向とし逆向きは Pub/Sub で知らせる

- **Decision**: 呼び出しは「セッション（skill）→ MCP（stdio、セッションごとに 1 つ）→ daemon」の一方向とする。daemon は出来事を SSE に出すだけで、MCP が購読し、自分のセッションの通知のソケット（`CLAUDE_CODE_MESSAGING_SOCKET`）に、auth の行と「受信箱を読んで（番号）」の 1 行を書く。中身は受信箱で読む。ソケットがない環境は、番の区切りのフックで受信箱を読む。
- **Rationale**: 依存の向きの決まり（NFR_014）。ソケットへの書き込みで、待っている CLI・裏・デスクトップの Code に新しい番が始まる。書く形は公式の文書（セッション間のメッセージ）にある。Claude の Bash で書くとふつうのモードで許可の確認が出るため、MCP のプロセスから書く。daemon から書くと「ほかのプロセス」として受け取る側の設定しだいになり、向きの決まりにも反する。知らせは番の区切りで届き、承認として扱われないため、急ぐ停止は親の `claude stop`、人間の判断は受信箱で扱う。
- **Rejected alternatives**: daemon が子を直接呼ぶ — 向きの決まりに反し、システムが起動しない形では子に届く口がない。MCP の list_changed・資源の購読 — 新しい番を始めない、または文書にない。Channels — research preview で、独自のものは開発用の旗が要る（公式になったら加える）。

## 2026-11-13 製品の名前を touryou にそろえる

- **Decision**: コード・コマンド・パッケージ・環境変数・ヘッダー・置き場・ブランチ・launchd のラベル・配布物・plugin と marketplace・skill の名前を、すべて touryou にそろえる（`@touryou/*`・`touryou`・`touryou-daemon`・`touryou-mcp`・`TOURYOU_*`・`x-touryou-*`・`~/.touryou`・`touryou/<key>`・`<org>.touryou.daemon`・`touryou-<版>-<target>.tar.gz`・`touryou-mcp-<版>.mcpb`・`touryou-<版>.zip`・plugin と marketplace の名前 `touryou`・skill `child`・`integrator`）。別の名前との互換は持たない。SQLite の `application_id` の印（"CSO1"）は、ファイルの形式の印で利用者に見えないので替えない。repo の URL は `comcreate/touryou` を指す。
- **Rationale**: 公開のあとに名前を変えると、利用者の設定・許可の一覧・常駐・道具の名前（`mcp__plugin_<plugin の名前>_node__*`）がすべて変わり、互換の処理が要る。公開の前なら、互換なしで 1 回で済む。
- **Rejected alternatives**: 短い別名を残す — 使う人がいないので、読む所と試験が増えるだけで得がない。

## 2026-11-14 状態はイベントログから導く

- **Decision**: 状態は追記のみのイベントログ（SQLite）から、`core` の純粋関数 `foldEvents`（`seq` の昇順の畳み込み）で導く。イベントは型付きの判別共用体で、未知の種別・`seq` の重複・木や遷移や回収の不変条件に反するイベントは、`seq` つきの失敗で全体を拒否する。壊れたイベントでも例外を出さず失敗を返す。daemon は追記の前に `applyEvent` で検査する。スナップショットは最新の 1 件のキャッシュで、状態のスキーマの版と末尾の行のハッシュが合うときだけ使い、合わなければ捨ててログから作り直す。
- **Rationale**: 再起動後の復元（NFR_002）と時系列の記録（NFR_011）を 1 つの列から満たす。新しいイベントが黙って無視されないようにする。
- **Rejected alternatives**: 状態の直接更新 — 復元と記録を別々に持つことになる。種別を文字列のまま持つ — 追加した種別を読み落としても気づけない。

## 2026-11-14 SQLite のドライバーを better-sqlite3 13 系にし Node 22 以上にする

- **Decision**: better-sqlite3 13 系（13.0.3 に固定）を使い、Node 22 以上（CI は 22・24）を対象にする。ドライバーは `EventStore` の裏の `sqlite-store.ts` に閉じ込め、`node:sqlite` へ差し替えられるようにする。追記のみをトリガーで守り（`UPDATE`・`DELETE`・置き換えの `INSERT` を拒否）、WAL と `synchronous = FULL`、`locking_mode = EXCLUSIVE` で二重に開くのを防ぐ（`storeLocked`）。`application_id` に固有値を書いて他のデータベースを巻き込まず（`schemaMismatch`）、スキーマの版は `user_version`（`schemaTooNew`）で見る。
- **Rationale**: 13 系は N-API のバイナリ（darwin・linux の arm64・x64）を同梱し、ビルドなしで入る。Node 20 は 2026-04 に EOL。12 系は保守終了の `prebuild-install` に依存する。`node:sqlite` は Node 22 で実験の扱いのため、安定してから差し替えを考える。
- **Rejected alternatives**: `node:sqlite` — 実験警告が出る。better-sqlite3 12 系 — 保守終了の依存がある。sqlite3・WASM 系 — 同期 API でなく、または遅い。

## 2026-11-14 停止は停止の確認と分け、プロセスの不在を確かめるまで stopped にしない

- **Decision**: 状態に `stopping`（停止要求済み、確認前）と `stopIncomplete`（停止要求後もプロセスが残る・確かめられない）を持つ。進行の事実は停止要求とは別のイベント（`stopTimeout`・`retryStop`・`confirmStopped`）にし、`running`・`waiting` から `stopped` へは必ず `confirmStopped` を通る。停止要求は状態ごとに受け付けを定める（`pending` は取り消しで `stopped` へ、停止中の再送は `changed: false` で成功、終わったノードは `alreadyFinished`）。回収可能の判定に「作業ツリー配下で動作中のプロセスがない」を条件 6 として加える。停止の観測は記録のみの `node.stopObserved`（`stopSeq`・`graceMs` つき）で、同じ停止の試行に 1 件だけ。
- **Rationale**: 「停止要求済み」と「停止を確認できた」を区別しないと、プロセスが残ったまま回収可能と判定される。停止後も残るプロセスが作業ツリーを書き換えうる。停止要求の冪等性を保ち、進行の事実と指示を分ける。猶予の既定値を記録から見直せるようにする。
- **Rejected alternatives**: 状態を増やさない — 停止の確認前に回収されうる。停止要求のイベントに観測まで全部載せる — 観測は後から分かる事実で、時点が違う。

## 2026-11-14 依存先の完了は verified 以降とする

- **Decision**: 依存先の「完了」は `verified` 以降（`verified`・`reclaimable`・`archived`。共通定数 `COMPLETED_STATES`）。`start` は `dependsOn` の全ノードがこのいずれかのときだけ許す。回収可能判定の条件 3 も同じ定数を使う。依存が揃った子は、`report.done`・`node.review`・`decision.answer` の後と起動時に、pending を走査して起動する（通知を持たず、毎回記録から判定する）。子を作れるのは親が `running` か `waiting` のときだけで、`dependsOn` に自分の祖先は指定できない。
- **Rationale**: 未検証の成果の上に後続を始めると、差し戻しのときに後続が無駄になる（spec 5.7）。依存先が先に回収されても後続が起動できるようにする。走査なら契機を取りこぼしても次で起動する。祖先を待つ子は決して進めない。
- **Rejected alternatives**: `done` で起動する — 差し戻しで後続が無駄になる。依存先の完了の通知を持つ — 取りこぼすと永久に起動しない。

## 2026-11-14 回収の判定はフェイルクローズの純粋関数にする

- **Decision**: 回収可能判定は、事実（統合済みか・きれいか・破棄判断済みか・作業ツリーのパス）、プロセス一覧、未回答の判断を持つノードを引数で受ける純粋関数 `assessReclaim` とし、`{reclaimable, unmet, blockers}` を返す。事実は `=== true` のときだけ満たしたとみなし、欠ける・パスが不正なら `factsMissing`、プロセス一覧が取れなければ `processesUnknown` で回収不可にする。cwd が不明なプロセスも動作中として扱う。`stopped` から `reclaimable` へは破棄の判断（`node.discardDecided`）を経た場合だけで、そのときは条件 1 と条件 2（未保存の変更）を免除し、作業ツリーとブランチを強制で消す（`--force`・`-D`）。破棄の判断は再開（`restart`）で消える。
- **Rationale**: 失うものがある場合は拒否する安全な手段だけを使う（spec 5.8、NFR_006）。回収不可の理由を短く示し、原因を名指しする。破棄の判断は成果を捨てることを含むので、判断の記録を正にする。
- **Rejected alternatives**: 欠けた入力は許可する — 成果を失いうる。ポートが強制を判断する — 判断の記録と食い違いうる。

## 2026-11-14 git の作業ツリーは git の登録を正とする

- **Decision**: ノードごとのブランチ（`touryou/<名前>`）と作業ツリー（`<worktreeRoot>/<名前>`）を、ノード ID から決定的に導く（ID の安全な部分とハッシュ 12 桁）。状態を持たず `git worktree list --porcelain` の登録を正とし、作成は親のブランチを上流にした `git worktree add --track -b`。削除は `--force` を使わず、ブランチは `-d`。未保存の変更・未追跡のファイル・再生成できない gitignore の対象（`regenerableIgnored` 以外。`.env` など）・未統合のコミットがあれば何も消さずに失敗する。git の環境は `GIT_` の変数を外し、`status` は fsmonitor とフックを走らせない形で呼ぶ。
- **Rationale**: 失うものがある場合は拒否する（NFR_006）。ブランチ名をエージェントに決めさせない（DC_003）。上流を親のブランチにすると、統合済みの判定と `-d` の削除が親を基準にできる。`git worktree remove` は gitignore の対象を黙って消すので、削除の直前にも確かめる。
- **Rejected alternatives**: daemon が作業ツリーの状態を持つ — git の登録と食い違いうる。

## 2026-11-14 窓口は 1 本の入口で認証と認可を順に通す

- **Decision**: daemon の窓口は `POST /v1/request`（127.0.0.1 だけ）の 1 本で全操作を受ける。Host・Origin、メソッド、認証（本文を読む前）、主体の検査（停止後・回収可能・アーカイブのノードのトークンは無効）、Content-Type、本文の上限（1 MiB）、ロールの判定、引数の検証、認可、ハンドラの順に、どこで失敗しても拒否する。ロールとノードは認証から決め、封筒の申告は食い違いを拒否するだけ。認可は `core` の `ROLE_OPERATIONS` と、統合ノードの部分木の規則（`SUBTREE_RULES`）で決める。受信箱・一覧は `visibleState` で呼び出し側の部分木に絞る。ロールの問い合わせは別の `GET /v1/whoami` で、ロールだけを返し、権限の判断には使わない。
- **Rationale**: 状態の唯一の窓口で権限を決める（NFR_004, DC_003）。申告を信じず、検証と認可を通らない値をハンドラに渡さない。兄弟の部分木を読めると、ロールの絞り込みが意味を失う。
- **Rejected alternatives**: 操作ごとに経路を分ける — 検査の順と漏れを経路ごとに保つ必要がある。

## 2026-11-14 窓口の契約の型を core に置き MCP の道具をそこから導く

- **Decision**: 窓口の契約（`Failure`、`Result`、操作の引数・結果、ロールごとの操作表）は `core` に置く。MCP で公開する道具は `core` の `ROLE_OPERATIONS` から導き、公開するのは統合と子だけ（人間用と最終削除は含めない）。道具の名前は操作名の `.` を `_` にしたもの。受信箱の次の操作の候補は種類ごとの表で固定する。受信箱の応答は既定を簡潔版にし、`asOfSeq` で分割取得の一貫性を保つ。
- **Rationale**: `mcp`・`cli` は `daemon` に依存できず、`core` だけが全員の依存先（A-001, NFR_001）。公開一覧の食い違いを防ぐ（NFR_004）。統合セッションが次の操作を迷わない（FR_012）。トークンの消費を抑える（NFR_009）。
- **Rejected alternatives**: 各パッケージが個別に型を持つ — 食い違う。

## 2026-11-14 要求の冪等性は内容まで比べる

- **Decision**: 同じ `requestId` で同じ内容（actor・type・payload。キー順は無視）は無視して成功し、内容が違えば `requestIdConflict` で拒否する。窓口の共通の層では、(主体, requestId) ごとの処理中の表を持ち、同じ組が実行中なら最初の結果を待って同じ応答を返す（待つ上限を超えたら 409 `inProgress`）。内部の requestId は呼び出し元と要求 ID から固定長のハッシュで導く。
- **Rationale**: 再試行を重複させず（NFR_003）、別の要求が同じ識別子を取り違えたときに気づけるようにする。ハンドラの冪等性は先の要求の追記が終わったあとにしか効かないので、並行した同じ要求の副作用が重ならないようにする。
- **Rejected alternatives**: 内容を問わず無視する — 取り違えに気づけない。実行中の重複をすぐ 409 にする — 中継の再送が最初の結果を受け取れない。

## 2026-11-14 トークンはハッシュだけを保存し紐付けは一回限りのコードで行う

- **Decision**: ノードのトークンはハッシュ・ロール・nodeId・発行日時だけを 0600 のファイルに保存し、定数時間で照合する。置き場とファイルの権限・所有者・形がおかしければ、黙って捨てず起動を失敗させる。人間のトークンは別の 0600 のファイル。紐付けは `POST /v1/bind` で、一度きり・既定 10 分・ノードに結ぶコード（Crockford base32 の 26 文字、130 ビット）を子ロールのトークンに替える。失敗は区別せず 401 で、ノードごとにはロックせず、全体の短いスロットル（429）だけを掛ける。失効の印は、そのトークンの最長の期限まで保存する。
- **Rationale**: 再起動で全子が止まらないようにしつつ、盗み見でトークンが漏れないようにする（NFR_002, NFR_005）。nodeId は誰でも申告できるので、ノードごとのロックは正規の子の紐付けの妨害に使える。推測への対策はコードの強さで足りる。失効の印が再起動で消えると、失効したトークンが「不正」と区別できなくなる。
- **Rejected alternatives**: トークンをメモリだけに持つ — 再起動で全子が紐付けし直しになる。イベントログに持つ — ログに秘密に近い値が残る。

## 2026-11-14 窓口に回数の制限を掛ける

- **Decision**: 自前の token bucket（`api/rate-limit.ts`）で、主体ごと（人間は 1、ノードは nodeId ごと）と、認証の失敗の 2 種類を制限する。時計は単調時計。429 は実行していないことを保証し、`Retry-After` を返す。
- **Rationale**: 暴走した子・総当たりから窓口を守る。429 が未実行を保証すれば、中継が安全に再試行できる。依存を増やさない。
- **Rejected alternatives**: `express-rate-limit` — 窓口は express ではない。

## 2026-11-14 子の範囲は親の範囲に収め拡張は親が判定する

- **Decision**: 子の生成・切り出しでは、作業ツリーを作ってから子の範囲を `validateScope` し、親の有効な範囲に `isScopeSubset` で収まるか検査してから記録する（落ちたら作業ツリーを片付ける）。ブリーフの場所は作業ツリー基準の相対パスに限る。作業ツリーとブランチは引数に含めず、アダプタが親のブランチから決める。範囲の拡張は、子の `scope.extend`（要求と親の受信箱の項目を 1 トランザクションで記録）と、統合ノード（対象の祖先）か人間の `scope.decide` で行い、判定の履歴を記録に残す。
- **Rationale**: 子が親より広い権限を持てないようにし（FR_005）、自分の権限を広げられないようにする（FR_015）。判定の履歴を時系列に残す（NFR_011）。
- **Rejected alternatives**: 子の範囲を検査しない — 親より広い権限の子が作れる。

## 2026-11-14 判断待ちの間の子の一時停止と回答の配送

- **Decision**: `decision.present` の `pauseNodeIds` で、判断の間、子孫を穏当に止める。回答が確定したら、判断の要求より後の停止要求がすべてこの判断が出したものの子だけを再開する（人間が止めた子・破棄の判断を経た子は除く）。回答は、判断を出した子へ追加の指示として届ける（判断 ID ごとに同時に 1 つ）。先に確定した回答を採用し、後から来た回答は却下として記録する（FR_019）。未回答の判断は、ノードごとに直近の開始・再開・差し戻しより後のものを 10 件まで。
- **Rationale**: 判断待ちの間に子が先へ進むのを防ぎ、回答のあとに戻す（FR_018）。人間の停止を優先し、二重に起動しない。回答が子に届かないと、子が判断を待つ使い方が成り立たない。判断要求の積み上げを防ぐ。
- **Rejected alternatives**: 子が `decision.get` で回答を取りに行く — 知らせで届くほうが待たずに済む。

## 2026-11-14 破棄が決まった子の未回答の判断を閉じる

- **Decision**: 人が破棄を決めた（`node.discardDecided`）ときに、その子の未回答の判断を閉じる（`status: "closed"`・`closedReason: "discarded"`）。止まっただけでは閉じない。閉じた判断には答えさせず（`decisionClosed`）、画面も回答の操作を出さずに理由を出す。
- **Rationale**: 判断待ちで止まった子には回答で再開する道があり、止まった時点で閉じると、その道をふさぐ。回収は停止した子に破棄の判断を必須にするので、破棄の時点で閉じれば、回収が未回答の判断で止まらない。
- **Rejected alternatives**: 止まった時点で閉じる — 回答による再開ができなくなる。

## 2026-11-14 起動時に記録とプロセスを合わせる

- **Decision**: daemon の起動時に、記録が running・waiting・stopping・stopIncomplete のままのノード（根とアダプタが管理している子を除く）を、作業ツリーのプロセスの有無に合わせる。プロセスがなければ、予期しない終了または停止の確認として stopped にする。残っている・調べられないなら、停止未完了にして受信箱に pid を出す。判断を待っていた子は、待っていた判断を記録に残し、回答で再開できるようにする。同じ状態での再実行は何も変えない。
- **Rationale**: プロセスの不在を確認するまで stopped としない（spec 5.3）。孤児プロセスを記録の上で見えるようにする。「プロセスがない」は調べた範囲に見つからなかっただけで、停止の証明ではないので、残っているときは安全側に倒す。
- **Rejected alternatives**: 起動時に何もしない — 記録が動いているままの子が残る。

## 2026-11-14 最終削除はログから行を消す専用の経路で行う

- **Decision**: 最終削除は `EventStore.purgeRows` の 1 経路だけで行う。1 つのトランザクションでトリガーを外し、行を消し、標識の行を追記し、スナップショットを捨て、トリガーを戻す。戻ったことを確かめられなければ以降の書き込みを拒否して daemon を止める。SQLite は `secure_delete = ON` で開き、削除のあとに WAL を切り詰める。墓標は既定で残し、事前確認で見せた木と違えば何も消さない（`purgeStale`）。自動の最終削除（`autoPurge`）は既定でオフで、有効にするときは保持期間 7 日以上、人間のコマンドと同じ関数を通る。
- **Rationale**: 追記のみの守りを、削除の経路だけで、しかも確かめてから外す。消した本文がファイルに残らないようにする。取り返しがつかないので、既定を安全側にし、事前確認と実行の間の変化に備える（FR_031、NFR_006、NFR_011）。
- **Rejected alternatives**: 追記・更新の経路に削除を足す — 追記のみの守りが弱まる。

## 2026-11-14 子の許可は範囲だけを許し dontAsk でほかを断る

- **Decision**: CLI の子は `--permission-mode dontAsk` で起動し、`permissions.allow` にノードの範囲から作った一覧（子の touryou の道具・`allowedCommands`・`writableLocations` の `Edit`・作業ツリーの中の読み取り）だけを入れ、禁止の場所と `.git` を `permissions.deny` に入れる。任意のコードが動く形のコマンドは一覧に入れず `invalidScope` で失敗にする。フックも同じ範囲を判定する（二重の守り）。
- **Rationale**: ふつうのモードの子は道具ごとに許可の確認で止まり、人が画面を開くまで進まない。dontAsk なら確認を出さずに範囲の外を断れる。前方一致の規則は続く引数をすべて通すので、任意のコードが動く形は範囲として受け付けない。
- **Rejected alternatives**: `acceptEdits`・`bypassPermissions` — 範囲の外まで通る。ふつうのモード — 子が止まる。

## 2026-11-14 CLI の子に親の plugin の場所を付ける

- **Decision**: 親の mcp が自分の `CLAUDE_PLUGIN_ROOT` を `parent_request` に添え、daemon が確かめたうえで、起動の文にいつも `--plugin-dir '<実パス>'` を足す。場所が作業ツリー・state・`~/.touryou` の中なら付けない。付けられなかったときと、一定の時間が過ぎても紐付けのない子は、親の受信箱に知らせる。
- **Rationale**: `claude --bg` の子には親の `--plugin-dir` が引き継がれず、plugin がないと紐付けもフックの守りも効かない。marketplace から入れた同じ plugin と重ねても 1 つにまとまるので、いつも付けてよい。作業ツリーに偽の plugin を置いて子に読ませるのを防ぐ。
- **Rejected alternatives**: 設定の置き場の外のときだけ足す — 重ねても害がないので、条件を持つ理由がない。利用者に plugin を入れてもらうだけにする — 入れ忘れた子は守りが効かない。

## 2026-11-14 Desktop の子は起動時の整合でプロセスと照合しない

- **Decision**: daemon の起動時の整合（`reconcileOnStartup`）で、Desktop の子（daemon の外で動き、アダプタが管理しない子）は、作業ツリーのプロセスと照合せず、記録の状態も変えない。記録で動作中・判断待ち・停止中・停止未完了の Desktop の子があれば、根の受信箱に、人に Desktop の画面で確かめてもらう依頼（stopIncomplete の帯）をまとめて 1 件出す。未解決の古い依頼は解決済みにして置き換え、未解決は常に 1 件までとする。人は子ごとに確かめ、止めたら `node.confirmStopped` で宣言する。これは FR_036 の「親に代行を依頼する」の一つの形で、根の受信箱を通して、親・人が Desktop の機能で確かめて、結果を宣言で返す。
- **Rationale**: Desktop の子は daemon の再起動の影響を受けず、アプリの再起動で自動で再開することもあるので、daemon からは止まったと決めつけられない。作業ツリーのプロセスでは確かめられず、照合すると動いている子を停止済み・停止未完了と誤って記録する。daemon が直接操作できない子の操作は親・人に依頼する（FR_036）。
- **Rejected alternatives**: CLI の子と同じくプロセスで照合する — 動いている子を誤って止まったと記録する。何もしない — 再起動の前の子が記録の上で動作中のまま見過ごされる。子ごとに受信箱の項目を出す — 再起動のたびに項目が増え、受信箱を埋める。

## 2026-11-14 未回答の判断と回答の配送を、結果の任意の欄で返す

- **Decision**: `tree.list` の `nodes` に `pendingDecisions`、`decision.answer` の結果に `delivery`（`delivered`・`skipped`）を、任意の欄として足す。既存の欄と、表の文面は変えない。cli は欄がなければ、今までの表示（子の状態からの見込み）に戻る。
- **Rationale**: 人が CLI で、止まった子の判断と、回答が子に届いたかを確かめられるようにする（FR_009）。任意の欄なら、古い cli・mcp・画面と新しい daemon、新しい cli と古い daemon のどの組み合わせでも壊れない。
- **Rejected alternatives**: 表の文面だけを cli で読み取る — 表は人向けで、形を約束していない。`notResumed` のように、届けなかったときだけ欄を出す — 古い daemon の「欄なし」と区別できない。

## 2026-11-14 受理した子のセッションは受理のときに親へ停止を依頼し、統合は fast-forward だけの道具で行う

- **Decision**: (1) 受理（accept）のとき、親が起動した CLI の子に、親への依頼として `claude stop` → `claude rm` を出す。状態は verified のまま変えず、状態遷移の表（verified への停止は `alreadyFinished`）も変えない。依頼の出し直しだけは `node_stop` が verified で受ける。(2) 統合ロールに `node.integrate` を足し、受理した直接の子のブランチを親のブランチへ fast-forward だけで進める。できなければ何も変えずに理由を返し、人間に判断を求める。
- **Rationale**: touryou はセッションを起動・停止しない（親が行う）ので、停止も起動と同じ親への依頼の形にそろえる。受理済みの成果に「停止」の状態を重ねると、verified → stopped の遷移が要り、停止したノードの回収に破棄の判断を求める規則（条件 1）とぶつかる。統合の事実は git の上流への到達で決まるので、回収の判定は変えずに、統合する手段だけを足せば流れが閉じる。fast-forward だけなら成果を書き換えず、コンフリクトの解消を自動で決めない。
- **Rejected alternatives**: `node_stop` を verified でも状態遷移として受ける（Issue #3 の案 2）— 受理のたびに親が別の操作を思い出す必要があり、状態の意味が二重になる。受理と同時に統合する設定（Issue #4 の案 2）— 受理と統合の失敗が混ざり、fast-forward できないときの扱いが受理の結果に入り込む。daemon が `claude stop` を自分で実行する — セッションを起動・停止しない原則（NFR_013）に反する。

## 2026-11-14 本体は plugin と別に配り、導入を plugin の中の 1 本の script にまとめる

- **Decision**: 案 B を採る。plugin は本体を同梱しないまま、/setup の取得・照合・展開・付け替え・動作の確かめと、版が変わったときの常駐の daemon の起動し直しを、plugin の中の `scripts/install-runtime.sh` にまとめ、1 回の承認で走らせる。取得元・版・sha256 は plugin の中の `checksums.json`・`plugin.json` からだけ読み、照合が通るまで展開も実行もしない。常駐の起動し直しは、チャットの「はい」のあとの `--restart-daemon` があるときだけで、失敗したら前の版に戻す（NFR_015）。版の食い違いは SessionStart のフックが知らせるだけで、取得も起動し直しもしない。
- **Rationale**: いまの /setup は約 12 回の承認で、人が 1 つずつ読むのは重く、読み飛ばしやすい。script は plugin の zip の一部で、marketplace の sha256 で zip ごと確かめられるので、中身を変えずに 1 回の承認に寄せられる。守りの変化: 人の目が見るのは「plugin の中の script を引数なしで走らせる」ことになり、個々のコマンドの確かめは、zip の照合と script の試験（照合の失敗・壊れた tar・外を指すリンク・同じ版・版の変化）に移る。tar.gz の sha256 の照合は変わらない。
- **Rejected alternatives**: 案 A（本体を plugin に同梱する）— zip が約 150MB になり、marketplace の配り方と更新の重さが変わる。plugin の update だけで本体が入れ替わり、常駐の daemon の起動し直しの同意を取る所がなくなる。案 C（今のまま、コマンドを 1 つずつ人が承認する）— 承認が約 12 回のまま。SessionStart のフックで自動で取得・起動し直す — 同意なしに子のセッションを止め（NFR_015 に反する）、ネットワークの取得がセッションの始まりを遅らせる。

## 2026-11-14 人に見せる製品名は TouRyou とし識別子は touryou のままにする

- **Decision**: 人が製品の名前として読む所（README の見出し・ロゴや画像の代替テキスト・アイコンの `<title>`・marketplace の説明・`.mcpb` の `display_name` と `description`・文書の地の文で製品を指す所）は TouRyou と書く。打ち込む・照合する・名前空間になる所（[2026-11-13 製品の名前を touryou にそろえる](#2026-11-13-製品の名前を-touryou-にそろえる) に挙げた識別子のすべて。パッケージ・コマンド・環境変数・ヘッダー・置き場・ブランチ・ラベル・配布物のファイル名・plugin と marketplace と skill の名前・`/touryou:*`・道具の名前・repo の URL）は小文字の touryou のまま。見分け方は「その文字を変えると、動き・照合・設定・許可の一覧が変わるか」で、変わるなら識別子、変わらず人が読むだけなら表示名。コードの書式（バッククォート）の中は識別子として扱う。
- **Rationale**: 2026-11-13 の決定は識別子をそろえることで、表示の書き方を決めていなかった。#40 で表示名を TouRyou にしたので、どこまでが表示名かの線を残さないと、識別子まで大文字にされて互換が壊れるか、表示名がばらつく。
- **Rejected alternatives**: 2026-11-13 の項に書き足す — 決定ログは追記のみで、過去の項は書き換えない。表示名も touryou にする — #40 で表示名を TouRyou にした決定と合わない。識別子も TouRyou にそろえる — 2026-11-13 の理由（公開のあとの名前の変更が利用者の設定を壊す）がそのまま当てはまり、大文字と小文字を区別する所（パス・環境変数・道具の名前）でずれる。

## 2026-11-14 Dependabot の actions の patch・minor の上げは、必須の check のあとに自動でマージする

- **Decision**: `.github/dependabot.yml` で github-actions だけを週に 1 回上げ、patch・minor を 1 本の PR にまとめ（メジャーは actions ごとの別の PR）、公開から 14 日たった版だけを使う（`cooldown`）。`dependabot-auto-merge.yml`（`pull_request`。checkout しない）が、`dependabot[bot]` の PR で、github_actions の semver-patch・semver-minor、変わったファイルが `.github/workflows/` の yml だけのときに auto-merge（squash）を付ける。マージは ruleset の必須の check のあと。メジャーの上げと、ほかの変更は人がレビューする。`GITHUB_TOKEN` のマージは main の push の CI を起こさないので、`dependabot-main-ci.yml`（`workflow_run`）がマージを待って main で `ci.yml` を `workflow_dispatch` で起こす。
- **Rationale**: actions は SHA で固定しており、手で版を上げ続けるのは重い。patch・minor は必須の check で壊れを見つけられ、14 日の cooldown で公開の直後の乗っ取られた版を避けられる（npm 側の `minimumReleaseAge` 14 日と同じ考え）。メジャーは入力や動きが変わり得るので、人が読む。`release.yml` の `marketplace-self` と同じ dispatch の形なら、新しい secret（PAT・App）が要らない。
- **Rejected alternatives**: `pull_request_target` で動かす — PR のコードを書き込みの権限で扱う恐れがあり、Dependabot の PR では `pull_request` で足りる。PAT・GitHub App のトークンでマージして main の push の CI を起こす — secret を足し、守る物が増える。main の CI を起こさない — main の上での確かめが抜ける。npm も Dependabot で上げる — npm は pnpm の `minimumReleaseAge` と lockfile で扱っており、二重になる。メジャーも自動でマージする — 動きの変わる上げを、人が読まずに入れる。メジャーも同じ group にまとめる — メジャーが 1 つ混じるだけで、patch・minor の自動マージまで止まる。

## 2026-11-15 plugin の shell script の変数は `${名前}` にそろえ、plugin-check で検査する

- **Decision**: `plugin/scripts/*.sh` の変数の展開は、すべて `${名前}` の形で書く（`$1`・`$?`・`$$`・`$#`・`$@` は除く）。`scripts/plugin-check.mjs` が、`plugin/` の中の `.sh` の `$名前` を拒み（shell でない言語の `$` の行だけ `# plugin-check: allow-dollar` で外す）、`$名前` のすぐあとに ASCII でない文字があるものは、`plugin/` とリポジトリの `scripts/*.sh` のどちらでも、印があっても拒む。試験は UTF-8 のロケールの組でも script を走らせる。
- **Rationale**: macOS の bash 3.2 は UTF-8 のロケールで、`$ver）` の全角の文字の 1 バイト目を名前の一部として読み、`set -u` の script が止まる（#47）。日本語の文を出す script ではほぼどこでも起きうるので、一部だけを直すのでなく、書き方を 1 つにそろえて機械で検査するほうが、見落としがない。
- **Rejected alternatives**: script の頭で `LC_ALL=C` にする — 出す日本語の文や、呼ぶコマンドのロケールまで変わり、書き方の罠も残ったままで、別の script で同じことが起きる。shellcheck で検査する — この形（名前のすぐあとの ASCII でない文字）を見ないうえ、CI と手元に新しい依存が増える。

## 2026-11-16 常駐の登録の前に、daemon の --check-config で設定を検査する

- **Decision**: `touryou launchd init`・`apply` は、書く・置く・`launchctl` を呼ぶ前に、`<base>/current/bin/touryou-daemon --check-config --config <base>/config.json` を実行し、終了コードが 0 でなければ何もせずに止まる。`--check-config` は daemon の `main` に足した、起動しない道で、起動と同じ `loadConfigFile` と git の口の作成（`createGitPorts` の実パスの検査）に、repoRoot が git のリポジトリか（`checkGitRepo`。`git rev-parse --git-dir`）を足したもの。CLI は、出力のパスを `<パス>` に伏せて出す。`launchd status` は、last exit code が 0 以外なら、`daemon.log` の最後の `失敗 [code]: …` の行を、伏せて長さを切って出す。plist の `KeepAlive`（`SuccessfulExit` が false）は変えない。
- **Rationale**: 消したフォルダを指した設定で常駐にすると、daemon は起動のたびに `invalidConfig` で落ち、KeepAlive で起こし直され続け、`status` には理由が出なかった（#65）。検査を daemon の入口に置けば、CLI に daemon（better-sqlite3 を含む）の依存を足さずに、daemon と同じ関数で検査でき、同じ `current` の版の検査になる（だぶった実装を作らない）。KeepAlive を変えると、ふつうの落ちたときの起こし直しまでなくなるので、変えずに、登録の前の検査と `status` の理由の表示で扱う。
- **Rejected alternatives**: CLI に `@touryou/daemon` の依存を足して関数を直に呼ぶ — 人間用のコマンドに、ネイティブのモジュールを持つ daemon を引き込む。CLI に実パスの検査を書き直す — daemon の検査とずれうる。`KeepAlive` を `false` にする・`SuccessfulExit` を外す — 設定の誤り以外で落ちたときに、起こし直されなくなる。daemon が設定の誤りで終了コード 0 を返して起こし直しを止める — 失敗が `status` から見えなくなり、`SuccessfulExit` の意味とも合わない。

## 2026-11-16 常駐の plist から、shell を通さず同梱の node で daemon を直に起こす

- **Decision**: `touryou launchd init` の plist の `ProgramArguments` を、`<base>/current/bin/node`・`<base>/current/lib/dist/bin.js`・`--config`・`<base>/config.json` にし、起動スクリプト（`run-daemon.sh`）を作らない。版は plist に書かず、配布物の版の印 `lib/dist-version` を daemon が読む。古い形の生成物は、古い `init` の生成物とバイト単位で同じときだけ置き換える・外す。版上げの戻しの道は、新しい版の `uninstall --yes` → 前の版の `init` → `apply --yes` にする。
- **Rationale**: shell の起動スクリプトを通すと、macOS のログイン項目に、起動スクリプト・`sh`・`bash` の 3 つが「開発元を識別できない項目」として出て、`uninstall` のあとも `sh`・`bash` が残り、利用者がマルウェアを疑った（Issue #64）。実行されたファイルごとに項目が出るとみて（推測。実機で確かめる）、実行するものを node 1 つにする。同梱の node は nodejs.org の公式の配布物で、署名つきの見込み（推測）。版を plist に書くと、版を上げるたびに plist が変わり、作り直しが要るので、配布物の中の印から読む。新しい版の生成物は前の版の `apply` では扱えないので、戻すときは、両方の形が分かる新しい版で外してから、前の版で作り直す。
- **Rejected alternatives**: shell を残して項目を減らす — `sh`・`bash` が残り、減るのは高々 1 つ。文書だけ — 不安の元が残る（説明は #59 で足した）。`AssociatedBundleIdentifiers`・署名 — 署名した .app に束ねるための鍵で、署名しない方針では使えない。版を plist の `EnvironmentVariables` に書く — 版を上げるたびに plist の作り直しと置き換えが要る。

## 2026-11-16 ad-hoc 署名の TouRyou.app で、ログイン項目に TouRyou の名前を出す

- **Decision**: macOS の配布物に `TouRyou.app` を置き、同梱の node を `Contents/MacOS/TouRyou` に入れる（`Info.plist` の CFBundleIdentifier は `com.comcreate-info.touryou`、CFBundleName・CFBundleDisplayName・CFBundleExecutable は TouRyou、LSUIElement は true、アイコンは `assets/icon/icon-512.png` から作る）。入れ物ごと手元の署名（ad-hoc。`codesign --force --sign -`。hardened runtime なし）にする。`bin/node` は、その node への相対のリンクにし、node は 1 つにする。常駐の plist の `ProgramArguments` の 1 つ目を `<base>/current/TouRyou.app/Contents/MacOS/TouRyou` にし、`AssociatedBundleIdentifiers` に bundle ID を入れる。`launchd apply` は TouRyou.app を LaunchServices に登録し、`uninstall` は登録を解く。v0.1.1 の形（`current/bin/node`）と v0.1.0 の形（`run-daemon.sh`）の生成物は、バイト単位で同じときだけ置き換える・外す（#64 の決めと同じ）。Apple の開発者の署名（Developer ID）と公証は見送る。**本番の正式リリースの前に見直す。**
- **Rationale**: v0.1.1 ではログイン項目に「Node.js Foundation」と出て、TouRyou の項目と分からなかった（#73）。実機の試し（11-16）で、入れ物の中の実行ファイルを起こすと、その名前（TouRyou）で 1 項目に出て、bootout と plist を消すとすぐ消えた。node をそのまま起こして `AssociatedBundleIdentifiers` だけ付ける形は効かなかった。Developer ID は組織の登録がなく、無料では作れないので、本番前の今は ad-hoc で出す（利用者の判断）。「開発元を識別できない項目」と出るのは ad-hoc のためで、文書で正常と書く。bundle ID は、組織の公開のドメイン（連絡先の comcreate-info.com）の逆 DNS にした。`AssociatedBundleIdentifiers` は ad-hoc では効かない見込みだが、害はなく、将来 Developer ID で署名したときに効く見込み。hardened runtime は、ad-hoc では要らず、付けると node の JIT に entitlements が要るので付けない。
- **Relation to earlier decisions**: #64（「常駐の plist から、shell を通さず同梱の node で daemon を直に起こす」）は、「TouRyou の本体は署名しない」とし、`AssociatedBundleIdentifiers`・署名を「署名しない方針では使えない」として退けた。この決めは、その方針を一部変える（同梱の node を ad-hoc で署名し直す）。「quarantine を外さない」方針（curl で取る・付いていたら止まる）は変えない。
- **Rejected alternatives**: Developer ID で署名・公証する — 組織の登録（年 99 USD・D-U-N-S・審査の待ち）が要る。本番の前に見直す（`.sdd/task/issue-73/signing-plan.md`）。node はそのままで `AssociatedBundleIdentifiers` だけ — 試しで効かなかった。自前の小さなランチャーで node を子として起こす — 自前のコードが増え、得が小さい。`SMAppService` に移る — 署名が要り、`launchctl` の道を作り直す手間が大きい。

## 2026-11-17 状態画面は、使い捨てのチケットを画面のセッションに交換して開く

- **Decision**: `touryou ui` が、`$HOME/.touryou/config.json` の `stateDir` から `port` と `human-token` を自分で読み、daemon の身元を確かめ（`docs/daemon-identity.md`）、`POST /v1/ui/ticket`（`human-token` だけ）でチケット（32 バイトの乱数・60 秒・1 回だけ・メモリだけ）をもらい、`http://127.0.0.1:<port>/ui#ticket=<チケット>` を macOS の `open` で開く。画面は、フラグメントを消してから `POST /v1/ui/session` で画面のセッションのトークンに交換する（チケットは試した時点で消える）。画面のセッションは人間と同じ主体として認証し、使わないと 1 時間・最長 12 時間で切れ、daemon のメモリにだけあるので起動し直すと切れる。チケットの誤り・期限切れ・使用済みは同じ 401 で断り、接続元ごとの認証の失敗の制限で数え、尽きたら照合せずに 429。`/ui#token=` の受け口は外し、貼り付けは予備に残す。ブラウザを開けない環境では、URL を出さずに「Mac のターミナルで `touryou ui` を実行してください」で止まる。plugin の `/touryou:ui` は、`touryou ui` を 1 回実行するだけ。OTP は入れない。
- **Rationale**: `human-token` は固定で失効の仕組みがなく、URL・`open` の引数に載せると、ブラウザの履歴・`ps`・シェルの履歴に残る（#88）。使い捨てのチケットなら、残るのは 60 秒で切れ、1 回で使えなくなる値だけで、画面のセッションも期限と失効がある。OAuth の認可コードと同じ形で、新しい暗号の実装が要らない。同じユーザーの悪意のあるプログラムは、トークンのファイルを直に読めるので、守り切らない（11-17 に利用者と決めた）。
- **Rejected alternatives**: `#token=` のまま `open` する — 長く使えるトークンが `ps`・履歴に出る。0600 の一時 HTML で開く — トークンがファイルに残る。時刻ベースのコード — 再生を防ぐのに結局 daemon の状態が要り、2 か所で HMAC をそろえる負担が増える。端末で承認する形・OTP の併用 — 手で打つ操作が増える（OTP は後の課題）。画面のセッションを storage・cookie に置く — 再読み込みで残る代わりに、盗まれる場所と CSRF の経路が増える。

## 2026-11-17 状態画面の関係図は、Rete.js を描画のプラグインなしで使い、CSP を変えずに別の束で配る

- **Decision**: 状態画面に、親子の関係とやり取り（上り・下り）とその進み具合を示す関係図を足す。図は `rete`・`rete-area-plugin`・`rete-readonly-plugin`（版は完全に固定）を esbuild で束ねた `/ui/graph.js` で描き、描画のプラグイン（React・Vue・Lit）は使わず、箱と線は自前の描き手（`el()`・`svgEl()`）で描く。配置は自前の純粋な関数で計算する（elkjs は使わない）。形は横向きの木（根が左・子ごとの端子・角丸の折れ線）。CSP は変えない。SVG を作るのは `svgEl` の 1 か所、動く玉の `offset-path` も 1 か所に閉じる。自前のコードはいまの走査に、束ねたライブラリは禁止の API の不在の試験にかける。npm の依存は手で上げる。やり取りの段（`sent`・`delivered`・`done`）は記録から導き、子 → 親の「届いた」は記録がないあいだ「分からない」と示す（#102 で足す）。タグの許可リストに `details`・`summary`・`code` を足す（#89）。
- **Rationale**: 利用者が Rete.js を選んだ（11-17）。Vue のプラグインは `<style>` を `innerHTML` で差し込み、React のプラグインは styled-components を使うので、どちらも CSP `style-src 'self'` に当たる。描画のプラグインなしなら、依存が最も少なく（見込み 17 KB・gzip）、CSP も走査の決まりも、閉じた所の追加だけで保てる。elkjs は EPL-2.0 OR GPL-3.0 で 8.2 MB あり、木の配置は自前で十分。線の交わりを減らすことが図の読みやすさに最も効く（research.md 8 節）。
- **Rejected alternatives**: 自前の SVG だけ（調べ役の勧め）— 利用者が Rete.js を選んだ。React・Vue のプラグイン — CSP に当たる。Lit のプラグイン — R0 が通らないときの次の道として残す。elkjs・`rete-auto-arrange-plugin` — ライセンスと大きさ。CSP に `'unsafe-inline'` を足す — 守りが下がる。図に子の数の上限を設ける — 幹からの枝分かれなら親の箱は伸びず、拡大・移動で扱える（利用者の決め）。

## 2026-11-17 済んだと報告した子（done）を、受理せずに止められるようにする

- **Decision**: 状態遷移で、done への停止要求（`stop`）を、猶予なしの即時停止として受け付ける（done → stopping。waiting と同じ扱い）。**done の子を止められるのは人だけ**にする（人間のロールに `node.stop` を足す。人が止められるのは done の子だけ。CLI は `touryou stop <nodeId> --yes`）。統合・親の `node_stop` は、done の子にはこれまでどおり `alreadyFinished` で断る。止めた done の子は受理の道に戻らない（受理は done からだけ）ので、「受理しない」を統合だけで決めさせないため。停止を確かめたら stopped になり、そこからは人間の破棄の判断（`node.reclaimInstruct`。`touryou reclaim --yes --expect`）で回収できる。成果は、破棄を決めるまで作業ツリーに残る。verified・reclaimable・archived への停止は、これまでどおり `alreadyFinished`（verified は、裏のセッションの依頼の出し直しのまま）。破棄は人の操作のままにし、統合や子から破棄できないことは変えない。
- **Rationale**: 済んだと報告したが受理しない子を片付ける道がなかった（`node.stop` は `alreadyFinished`、破棄は `notStopped`。#115）。受理しないまま放っておくと、作業ツリーとセッションが残り続ける。done の子のプロセスは動いていないことが多いので、猶予は要らない。止めるだけなら成果は消えず、捨てるかは人間が決める（2 段階のまま）。
- **Relation to earlier decisions**: 2026-10 の「停止要求は状態ごとに受け付けを定める（終わったノードは `alreadyFinished`）」の、「終わったノード」から done を外す。
- **Rejected alternatives**: done から直接破棄できるようにする — 停止の確かめ（作業ツリーのプロセスがない）を飛ばすことになる。受理してから回収させる — 受理は依存先の完了になり、中身を確かめていないものを受理させることになる。統合・親も done の子を止められるようにする — 止めると受理できなくなるので、人の決めるべき「受理しない」を統合が決められてしまう（レビュー）。


## 2026-11-18 作業ツリーもブランチもない停止ノードは、破棄の判断で記録だけを archived にする

- **Decision**: daemon の `factsFor` は、作業ツリーの一覧（`git worktree list`）が取れ、そのノードの登録がなく、作業ツリーの場所にディレクトリもなく、ブランチ（`touryou/<名前>`）もないときだけ、消すものがない事実（`gone`）を返す。回収のハンドラは、`gone` を、停止したノード（`stopped`）と、破棄で回収可能にしたノード（`reclaimable` で破棄の判断がある）にだけ使い、それ以外のノードでは `factsMissing` として扱う。人が破棄を決めれば（先端がないので `noTip`）、回収は消すものがないことを確かめ直し、記録だけを `archived` にする。`factsMissing` のノードには、`touryou reclaim` と画面は破棄を指示しない（理由と次の操作を出す）。2026-11-14 の「回収の判定はフェイルクローズの純粋関数にする」の `factsMissing` は、この場合を除いて、そのまま。
- **Rationale**: 作業ツリーとブランチがすでに消えた止まった子は、片付ける道がなく残っていた（#137）。消すものがないことを git の登録・場所・ブランチの 3 つで確かめれば、成果を失わない（NFR_006）。一覧が取れない・場所が残るなどは確かめられないので、これまでどおり回収不可に倒す。破棄の判断の経路だけに限るので、統合済みを前提とする通常の回収（検証済みのノード）は変わらない。破棄を指示しても回収できないノードに指示を記録すると、「破棄を指示済み」の表示と事前確認が食い違うので、指示の前に止める。
- **Rejected alternatives**: 事実がないときも、破棄の判断だけで archived にする — 作業ツリーが置き場の外や別の場所に残っていても気づけない。破棄の判断を事実から切り離して core の入力を変える — 事実がないまま判断だけで通る道ができ、フェイルクローズが弱まる。`factsMissing` のまま、CLI の表示だけを直す — 片付ける道がないまま残る。

## 2026-11-20 attach で mcp が入れ替わった CLI の子は、コードなしでつなぎ直せる（案 B）

- **Decision**: CLI の木だけで、`POST /v1/bind` に `bindCode` なし・`cwd` と `sessionId` ありの「つなぎ直し」を許す。新しい mcp（紐付け待ち）は、`child_bind` を引数なしで呼ばれ、コードのファイルが「ない」ときだけ、印のノード ID・`CLAUDE_CODE_SESSION_ID`・作業ディレクトリを送る。daemon は、次のすべてが合うときだけ、子ロールのトークンを出し直す（前のトークンは無効になる）: (1) 作業ツリーの確認（cwd の実パスがそのノードの作業ツリーで、`.git` がファイル）、(2) 記録（`node.sessionBound`）にあるそのノードの session_id と同じで、ノードが終わっていない、(3) その session_id がほかの生きているノードに結ばれていない、(4) そのノードが今も有効な紐付けのトークン（`bind`）を持つ、(5) ノードが子ロールでトークンを持てる状態。どれか 1 つでも外れたら、コードが無効なときと同じ 401・同じ文・同じ失敗の数え方にする（理由を外に出さない）。受信箱の「紐付けをやり直して」（`onBindInvalid`）は出さない。つなぎ直しの成功は、記録（`bindSucceeded`）に `route: "rebind"` を付けて見分ける。Desktop の木は、コードなしの bind を必ず断る（`rebindOk` を渡さない）。session_id の記録は、これまでどおり正しいコードでの紐付けでだけ作る。
- **Rationale**: 利用者の決め（#145）。`claude attach` で mcp が入れ替わるとメモリのトークンが消え、コードは 1 回きりなので、人が `node_bindCode` を頼むしかなかった。session_id だけでは身元にならない（秘密でない）ので、daemon が持つ別の事実（作業ツリーの実パス・コードで結んだ記録・今も生きている紐付けのトークン）と組み合わせる。(4) を要るとしたのは、つなぎ直しで期限を延ばし続けられないようにするため: 紐付けのトークンの「使わなければ 1 時間・発行から 24 時間」の期限が、そのままつなぎ直しの上限になる。期限が切れた・失効した・止められた子は、人がコードを出し直す（これまでどおり）。つなぎ直しはトークンを発行し直すので、発行から数える 24 時間の絶対の期限も数え直される（コードでの紐付けと同じ扱い）。
- **守りが弱くなる所**: 同じ OS のユーザーの別のプロセスが、ノード ID・session_id・作業ツリーの 3 つを知っていれば、コードなしで、その子のトークンを取れる（フックの `sessionIdOnly` と同じ程度の信頼に、トークンの出し直しが加わる）。取られた側（本物の子）は前のトークンが無効になり、401 で紐付け待ちに戻る（気づける）。ノード ID と作業ツリーは、同じユーザーなら読める。session_id は秘密でない。失敗は、全体のスロットルと接続元ごとの bucket で数える（総当たりの上限は、コードの場合と同じ）。
- **未確認の前提**: attach のあとの新しい mcp の `CLAUDE_CODE_SESSION_ID` が、元のセッションと同じか。違えば、つなぎ直しは通らず、これまでの案内（親に `node_bindCode` を頼む）に落ちる（壊れない）。実機で確かめる（`docs/manual-verification-checklist.md` の A4-3。A1-5 も参照）。試験は、この前提を確かめない（同じ値が送られる場合の daemon・mcp の動きだけを確かめる）。コードでの紐付けのときに環境変数がなかった子は、記録がないので、つなぎ直せない。
- **Rejected alternatives**: 案 C（使ったコードを短い間残す）— コードが漏れる時間が延び、同じ session_id に頼る点は案 B と変わらない。紐付けのトークンの有無を見ずに、記録だけで出し直す — つなぎ直しで期限をいつまでも延ばせ、24 時間の上限が意味を失う。つなぎ直しの失敗に別の文・別の状態コードを返す — 記録の有無・期限の状態を外から探れる。Desktop の木にも広げる — フックの確かめ（`hookFresh`）が前提で、attach の問題が違う。

## 2026-11-22 サブ統括の紐付けはノードのロールに従った統合トークンで行う（#168 判断 1・案 A）

- **Decision**: `bind.redeem` と `rebindNodeToken` は、bind コードに結びつくノードの `role` を読み、`integrator` なら統合トークン、`child` なら子トークンを発行する（再紐付けは、いまのトークンのロールを引き継ぐ）。ロールは呼び出し側の引数から受け取らない。`checkPrincipal` の「トークンのロール＝ノードのロール」は変えない（子トークンで統合の操作はできない）。`node.bindCode` の `integratorNotSupported` は、CLI の木のサブ統括（親のいる統合ノード）について外す。bind コードは**直接の親**の統合ノードか人間が発行する（子の bind コードは、これまでどおり祖先の統合ノードも発行できる）。一度きり・10 分の期限・SHA-256 保持は変えない。`node.hookToken`（人間専用）も、サブ統括に発行できる。
- **設計書（#168 design.md §3）から変えた点**: (1) 根（親がない統合ノード）の bind コード・フック専用トークンは、人間でも発行しない。根の資格は人が用意する常駐のトークンで、コードで根のトークンを作る経路を作らないため。(2) Desktop の木のサブ統括は、これまでどおり `integratorNotSupported`（設計書の「v0.1.7 は CLI のサブ統括だけ」に合わせる）。
- **Rationale**: 紐付けの経路を 1 本に保てる（一度きり・10 分・SHA-256 保持の既存の防御をそのまま使う）。ロールがノードの属性で決まるので、子が自分で統合に昇格する経路ができない。権限の違いは `ROLE_OPERATIONS` と部分木の規則で表され、サブ統括の操作は自分の部分木の外に効かない。
- **Relation to earlier decisions**: 2026-11-20 の「つなぎ直しは子ロールのトークンを出し直す」を、「そのノードのロールのトークン」に広げる（条件 (1)〜(4) は変えない）。
- **Rejected alternatives**: 統合用の別の bind 経路 — 経路が 2 本になり、防御（期限・スロットル）を二重に保つ必要がある。root が統合トークンを代行発行 — 一度きり・期限の仕組みを迂回し、root に秘密の受け渡しが集中する。統合ノードの紐付けを今後も不可にする — #168 の目的を満たさない。

## 2026-11-17 project 設定の marketplace は、管理者が付ける marketplace-v<版> の tag に固定する（#90）

- **Decision**: `.claude/settings.json` の `extraKnownMarketplaces.touryou.source.ref` を `marketplace-v<版>` の tag にする。`release.yml` が出す PR に、`marketplace.json` の版と `ref` の更新を同梱する。マージのあと、管理者が手元でそのマージのコミットに tag を付ける。`release-tags` の ruleset の対象に `refs/tags/marketplace-v*` を足し、作成・更新・削除は管理者だけにする。CI で、`ref` と `marketplace.json` の版の一致、tag の存在と中の版の一致を照らす。
- **Rationale**: 固定の参照は、それを作る側（リリースの仕組み）が責任を持ち、tag は付け直し・削除ができないことで初めて不変になる。ruleset の対象に 1 つの形を足すだけで、tag を作れる者は増えない。tag の名前は `v*` に当たらない `marketplace-v<版>` にする（`v*` に当たると Release が作られてしまう）。
- **Rejected alternatives**: workflow が自動で tag を付ける案 — tag を作れる者に GitHub Actions が加わり、ruleset の外の tag は付け直せて不変にならない。zip を再現できる形で先に作り `marketplace.json` を tag に含める案 — ビルドとリリースの流れの作り直しが大きすぎる。固定しない案 — 自動で入る経路をなくすだけで目的を下げる。保護した `marketplace` ブランチを `ref` にする案 — 不変ではない。

## 2026-11-21 止まった子を開く claude attach は、セッション番号の形を優先して出す（#150・#205）

- **Decision**: 状態画面が出す `claude attach` は、CLI の子の起動の報告の `sessionRef`（`claude agents --json` の id）を使う。`sessionRef` は表示モデルの応答にだけ載せ、新しい記録（イベント）は足さない。画面は、番号が分かるときは番号の形だけを出し、分からないときだけノード ID（`--name` の名前）の形を出して、番号を調べる案内を添える。
- **Rationale**: `claude attach` が引くのは `claude agents --json` の id で、`--name` の名前ではない。名前の形は子のプロセスが動いているときしか開けず、2 つ並べると先に名前の形で失敗する。停止・削除の依頼はすでに起動の報告の id を使っており、attach だけが食い違っていた。構造化はデータソースに近い core の表示モデルで行い、画面は渡された値を使うだけにする。
- **Rejected alternatives**: daemon が表示モデルの外から付ける案 — 構造化がデータソースから離れる。画面が `claude agents --json` を打つ形の文を出す案 — シェルの展開を含む文は「変数なし・値は引用済み」の方針に合わない。

## 2026-11-21 401 を受けた子は、資格情報を捨てる前にコードなしで 1 回だけ結び直す（#185）

- **Decision**: mcp は、daemon から 401（`unauthenticated`）を受けたとき、資格情報を捨てる前に、印・セッション ID・作業ツリーによるコードなしの結び直し（`rebindChild`）を 1 回だけ試す。通れば新しいトークンに差し替えて購読も張り直し、通らなければ従来どおり資格情報を空にする。空にしたあとの `not_bound` の文は、最初から未紐付けの場合と、紐付けが外れた場合に分け、外れた場合は MCP の接続ではなく紐付けが外れたと明示し、`child_bind` を引数なしで呼ぶよう案内する。
- **Rationale**: 401 の出どころは 1 つに決まらなかった（再起動の直後に有効なトークンが 401 になる経路は見つからなかった）。出どころが特定できなくても成り立つ直しとして、mcp 側の自動の結び直しと、文の区別を選んだ。
- **Rejected alternatives**: None considered。

## 2026-11-21 外れた子の知らせは、child_bind の失敗を daemon が受信箱に出す形にする（#186）

- **Decision**: 子が外れたことを知らせる専用の道具は作らない。コードなしの結び直し（`POST /v1/bind`）が、作業ツリーの確認を通ったあとで失敗したときに、daemon が自分の確かめで、既存の `rebind` の知らせを親の受信箱に出す。出すのはノードごとに 1 回で、`node.bindCode` の出し直しで解ける。
- **Rationale**: 認証のない呼び手の自由文を親（LLM）の受信箱に入れると、プロンプト注入の入口になる。daemon が自分で確かめた事実から文を組み立てれば、守りは弱まらない。トークンも新しい権限も出さない。
- **Rejected alternatives**: 紐付け前だけに出す専用の道具 — 認証のない入口とフックの許可が増え、守る面が広がる。子の自由文を受信箱に入れる案 — プロンプト注入の入口になる。

## 2026-11-22 子の最後の動きの数え方は core の 1 か所に置き、受信箱の項目は数えない（#195）

- **Decision**: 動きの数え方（`lastActivityMs`）と、待つと決まっている子の判定は、`packages/core/src/activity.ts` に 1 か所だけ置き、見張りと状態画面の両方が使う。受信箱の項目は数えない。
- **Rationale**: 見張りと画面で数え方が違うと、同じ子が「動いている」と「止まっている」に食い違う。データに近い層で 1 か所にそろえる。受信箱の項目を数えないのは、「止まっているかも」の知らせ自体が動きに見えてしまうため。
- **Rejected alternatives**: None considered。

## 2026-11-22 子が出した判断は、子自身が取り下げられるようにする（#196）

- **Decision**: 子のロールだけが、自分が出して開いたままの判断を `decision.withdraw`（イベント `decision.withdrawn`）で取り下げられる。取り下げた判断は `closed`（理由 `withdrawn`）になり、waiting でほかに開いた判断がなければ running に戻す。判断への回答は従来どおり人だけが行い、人があとから答えた場合は「取り下げ済み」と返す。
- **Rationale**: waiting から running に戻る道が人の回答しかなく、判断が不要になった子が done にできず止まっていた。取り下げは子自身の判断だけに限り、人の回答の権限は変えない。
- **Rejected alternatives**: None considered。

## 2026-11-23 統合済みの子の回収を人間だけが一括で行えるようにし、対象は祖先判定で統合済みと分かるものに限る（#234）

- **Decision**: 一括の回収（`node.reclaimBatchPreview` と `node.reclaimBatch`）は人間のロールだけに許し、integrator と child には許さず、MCP の道具としても出さない。対象は祖先判定で `merged: true` と分かるものだけにする。確認は `--yes --expect <digest>` の形で、照合の値は daemon が計算し、実行の直前に対象を再計算して、違えば `digestMismatch` で何も消さない。強制は使わず、1 件の失敗は `failed` に入れて残りを続ける。
- **Rationale**: 取り消せない操作なので、親の AI が一括で消せないことを最優先にした。実行の直前に再計算してプレビューからの変化に追従し、git 自身の拒否を最後の防壁として残す。
- **Rejected alternatives**: スカッシュ済みを GitHub の PR 状態で判定する案 — `gh` と認証とネットワークに依存する。`git cherry` による判定 — 複数コミットをまとめたスカッシュを検出できない。tree の一致による判定 — スカッシュ後に main が進むと外れる。件数を打ち込ませる確認と 1 件ずつの確認 — `touryou reclaim` と同じ形を選んだ。親の AI への許可 — 一括で消せないことを優先した。

## 2026-11-23 スカッシュ後の統合済みは、人間の側が取った PR の証拠で判定し、verified にも破棄の道を作る（#239）

- **Decision**: 統合済みの判定は、祖先判定に加えて「統合済みの証拠」（`node.mergeEvidenceRecorded`。先端 `tip` に紐付き、人間のロールだけが記録できる。事実に `mergedBy: "ancestor" | "evidence"`）を使う。証拠は人間の CLI が `gh` で PR の `headRefOid` と `MERGED` を取って渡し、使えないときは人の宣言（`touryou reclaim <nodeId> --merged-as <PR 番号 | SHA>`）に落とす。daemon は `gh` を呼ばず、先端の一致だけを確かめる。証拠つきの削除は、先端を `refs/touryou/discarded/` に保管してから `git branch -D` で行い、保管に失敗したら何も消さない。`verified` の破棄は `node.reclaimInstruct` を `verified` にも許す。一括回収は証拠つきを対象に含め、実体のない `verified` は含めない。
- **Rationale**: 事実の判定は事実のある層（GitHub、人間の側）で行う。AI が作れない証拠だけに絞れば、人間のロールだけ・強制なし・digest 照合の原則と矛盾しない。状態の意味（`verified` は受理済み）を変えず、記録の上に破棄の道を作れる。
- **Rejected alternatives**: ローカル git だけの判定（`git merge-tree`・差分の適用）— 上流が取り消した変更を統合済みと読む危険がある。木・パスの一致 — 削除・リネームに穴がある。`verified → stopped` の遷移や `stop` を `verified` に許す案 — 受理済みの意味が逆戻りする。state.db の直接書き換え。daemon が `gh` を呼ぶ案 — 常駐環境に認証が要る。`goneUsable` に `verified` を足すだけの案 — 判断の記録が残らない。

## 2026-11-23 範囲拡張の依頼は、通らないと分かった時点で要求の段階で断る（#249）

- **Decision**: `scope.extend` の要求時にも、判定と同じ `checkApprove`（規則は 1 か所）を人間の判定として走らせる。`scopeNotSubset`・`scopeDenied`・`scopeInvalid` なら、記録も受信箱の項目も作らずに子へ返す。一時的な失敗は断らず、判定時の検査に任せる。親が根で、規則に直せる依頼は、「上限にも足して承認」で通せるので、今までどおり画面に出す。`scopeNotSubset` の文には、近い許可コマンド（`nearestAllowedCommand`）を添える。
- **Rationale**: 押せるボタンつきで必ず失敗する依頼を人に見せない。検査の規則を 2 か所に書かない。
- **Rejected alternatives**: 収まらない依頼をすべて要求時に断る案 — 「上限にも足して承認」の道がなくなる。前方一致を末尾一致に緩める案 — 許可が広がる。画面でボタンを無効にする案 — daemon で断れば画面に出ない。

## 2026-11-23 作業ツリーへの ignored ファイルの配置は、既存のコピー一覧で足し、設定したコマンドの実行は足さない（#250）

- **Decision**: 新しい作業ツリーへの ignored ファイルの配置は、既存の `<repoRoot>/.claude/touryou-worktree-files.json` の `files` のコピーで足りるとする。作成後の hook も、元がないときの再生成コマンドも足さない。コピーは `COPYFILE_FICLONE` にし、丸ごと gitignore のディレクトリは、一覧のファイルを含むものだけ `--ignored=traditional` でファイルごとに開いて回収の「きれいか」の判定に反映する。一覧にないファイルが同じディレクトリにあれば、きれいでないにする。
- **Rationale**: 一覧は利用者の `repoRoot` の `.claude/` にあり子は書けないので、設定者は信頼できる。課題は「バイナリを 1 つ置く」だけで、任意のコマンドを走らせる経路は過大。
- **Rejected alternatives**: 作成後に走らせる設定したコマンド — 安全面の設計が重く、作成が直列なので長引くと全体が止まる。元がないときの再生成コマンド — 子の起動の成否がネットワーク次第になる。

## 2026-11-23 手の空いた CLI の子の紐付けの戻しは、MCP が自分で行い、統括は利用者に聞いてコードを出す（#255）

- **Decision**: 紐付け待ちの子の MCP が、起動直後と定期の確認で、コードのファイルが現れたら自分で使い、なければコードなしの結び直しを間引いて試す。通ったら購読を張り直し、自分の受信箱のソケットに固定の 1 行を 1 回だけ書いて、手の空いた子を起こす。最初の起動でコードのファイルがあるときは、コードなしの結び直しを試さない。サーバー側の条件は変えない。戻らないときは、統括が `AskUserQuestion` で利用者に聞き、承認後に既存の `node_bindCode` を呼ぶ。新しい道具は足さない。
- **Rationale**: 攻撃面を増やさずに、子の AI が `child_bind` を呼ぶことだけに頼っていた入口を MCP 側に足せる。人の許可を挟む線引きは、既存の `node_bindCode` の権限のまま保てる。
- **Rejected alternatives**: idle 失効後もコードなしの結び直しを通す案 — 使われていないセッションのトークンを残さない守りが薄まる。統括向けの新しい道具 `node_repairBinding` — 承認が自己申告になり守りにならない。daemon から子の受信箱のソケットへ書く案 — 認証前の入力の道ができる。統括が `claude attach` や `claude --bg` を代行する案 — 人間のロールだけの操作が曖昧になる。

## 2026-11-27 設定の「cwd から上へ」の探索は、git のリポジトリの根で止める（#312）

- **Decision**: `findConfigUpward`（`locateConfig` の 3 番目の段）と、導入の script の `config_in_ancestors` は、cwd から上へ `<dir>/.touryou/config.json` を探すとき、**その階層の設定を調べたあと、`<dir>/.git/HEAD` がある階層（git のリポジトリの根）で止まる**。リンクした作業ツリー（`.git` がファイル）は根とみなさず、上へ続ける。`$HOME` は、TS 側では特別扱いしない（設計書 4-2 のまま）。script は、これまでどおり `$HOME/.touryou/config.json`（前の置き場）を当てない。core は純粋なまま、既存の `exists` だけで判定する（`.git/HEAD` の有無）。
- **Rationale**: 上限なしに `/` まで探すと、リポジトリの外の祖先（`~/src/github.com/<org>/.touryou/config.json` など）にある別のリポジトリの設定を、その下の設定のない別のリポジトリが拾う。すると `/touryou:setup` が `CONFIG: present` と判定して作成・移行（`touryou migrate`）を案内せず、mcp・hook・cli は別の `repoRoot` の daemon につながる。リポジトリ単位の置き場（#288）の考え方（設定はリポジトリのもの）に合わせ、探す範囲もリポジトリまでにする。`.git/HEAD` で見るのは、子の作業ツリー（`<repoRoot>/.touryou/worktrees/<子>`）と、`repoRoot` の外に置いた `worktreeRoot` の子が、`.git` がファイルなので止まらず、親の設定に届くようにするため（子の mcp は設定を明示で渡されず、この探索に頼る）。
- **守りが残らない所**: 設定が根の外にある環境（リポジトリの外の祖先に置いた設定を、リポジトリの中から使う）は、探索では届かない。`--config`・`TOURYOU_DAEMON_CONFIG` で指す。また、別のリポジトリのリンクした作業ツリーは、根ではないので、外の祖先まで上へ続く（親の設定を指す印の検証は、この決定に含めない）。`$HOME` が git のリポジトリでないとき、TS は `$HOME/.touryou/config.json` を、リポジトリでない場所からの探索で当てうる（script は当てない）。
- **Rejected alternatives**: 根で止めず、`$HOME` までに限る — 別の祖先（`$HOME` の下の組織のフォルダ）の設定を拾う問題が残る。最初の `.git`（ファイルを含む）で止める — 子の作業ツリーが親の設定に届かない（`docs/config.md` の約束を破る）。`$HOME` を TS でも除く — 設計書 4-2 と既存の試験の前提（`$HOME` を根にした固定）を変え、本題に効かない。

## 2026-11-14 技術スタックは憲法の技術制約と Library-First に合わせて選ぶ

- **Decision**: 言語・実行は TypeScript（ESM、Node.js 22 以上）、MCP は MCP TypeScript SDK と zod、状態の保持は SQLite（better-sqlite3。追記型のイベントログ）、テストは Vitest と fast-check とする。子の起動は使わない（親のセッションが `claude --bg` で起動するか、人間が Claude Desktop で開く）。
- **Rationale**: 言語とテストは憲法の技術制約による。MCP は Library-First に従い、独自プロトコルを作らない（憲法）。子を起動しなければ、認証を扱わずに済む。状態の保持は、再起動後の復元（NFR_002）と時系列の記録（NFR_011）を、追記型のイベントログという 1 つの仕組みで満たせる。
- **Rejected alternatives**: None considered。

## 2026-11-17 作業ツリーの中を探す読み取りだけのコマンドは範囲によらずフックで許し、子の許可の一覧には足さない

- **Decision**: 作業ツリーの中を探す読み取りだけのコマンド（`ls`・`find`・`grep`・`git ls-files`・`git grep`）は、範囲の `allowedCommands` によらず、フックが許す（FR_014: 読み込みは制限しない）。許すのは、オプションがコマンドごとの許す表にあり、パスが作業ツリーの中にあり、禁じる場所に当たらないときだけ。子の permissions には足さない。CLI の子（dontAsk）のフックは許したときに明示の許可を返し、Desktop の子（SDK）のフックは明示の許可を返さない。
- **Rationale**: Claude Code の native 版は Glob・Grep の道具を出さず、Bash で探させるため、探索を許さないと子が作業ツリーを調べられない。permissions に `Bash(find:*)` を足すと、フックのない子で `find -exec` まで通ってしまう。
- **Rejected alternatives**: `Bash(find:*)` などを子の permissions に足す案 — フックのない子で `find -exec` まで通る。

## 2026-11-17 承認した範囲の拡張だけにあるコマンドは、フックが明示の許可を返して子がすぐ使えるようにする（#91）

- **Decision**: CLI の子のフックは、有効な範囲（ブリーフ＋承認済みの拡張。イベント列から毎回導く）で判定する。承認済みの拡張だけにあるコマンドで、区切りで分けた各部分の語が数まで同じ（完全一致）、かつ起動のときの一覧と同じ規則（`cd` 始まり・1 語だけ・任意のコードが動く形の禁止）を通る Bash には、明示の許可（`permissionDecision: "allow"`）を返す。前方一致のぶんはフックだけ通し、Claude Code の判定に任せる。書き込みの拡張（`kind: "write"`）も、有効な範囲で通る場所への書き込みの道具に明示の許可を返す（禁じる場所の `Edit` の deny は効いたまま）。承認の時点では、任意のコードが動く形を断らず、明示の許可を付けないだけにする。
- **Rationale**: 起動のあとに承認した拡張は、起動のときの `permissions.allow` に入らず、dontAsk の子はそのコマンドを断られてしまう。deny・ask の規則は明示の許可のあとも効くので、許しを広げすぎない。
- **Rejected alternatives**: None considered。

## 2026-11-23 結び直しの案 1-B（起動直後の 1 回だけ）と 1-C（idle 失効のあとにも通す）は採らない（#255 の却下案の補足）

- **Decision**: 紐付けの戻しで、起動直後の 1 回だけ結び直す案（1-B）と、daemon が idle 失効のあとにもコードなしの結び直しを通す案（1-C）は採らず、1-A（起動直後と定期の確かめ）と 2-A（統括が利用者に聞いて `node_bindCode`）の組み合わせにする。
- **Rationale**: 1-B は、`claude attach`・Reconnect のあと（経路 A）は戻るが、起動のときにまだコードのファイルがない場合（idle 失効のあとに親が出し直す場合。経路 C）が戻らないため。1-C は、トークンの期限の設計（#189・#198）と失効の印の扱いを変え、守りへの影響が大きいため（投資の評価は `.sdd/task/255/investigation.md` の案 1-C）。
- **Rejected alternatives**: 1-B（起動直後の 1 回だけ）— 経路 C が戻らない。1-C（idle 失効のあとにも結び直しを通す）— 使われていないセッションのトークンを残す守りが薄まる。
