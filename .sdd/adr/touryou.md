---
id: "adr-touryou"
title: "touryou 決定ログ"
type: "adr"
status: "approved"
sdd-phase: "implement"
created: "2026-11-11"
updated: "2026-11-15"
depends-on: ["spec-touryou", "design-touryou"]
tags: ["claude-code", "mcp", "orchestration"]
category: "developer-tooling"
---

# TouRyou 決定ログ

技術設計は [touryou_design.md](../specification/touryou_design.md) にある。

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
