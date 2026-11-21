packages/core/src/contract.ts:340:  "report.decision": {
packages/core/src/contract.ts:617:    "report.decision",
packages/daemon/src/api/handlers/state-handlers.ts:411:    "report.decision": (req: HandlerRequest<"report.decision">): R<"report.decision">
packages/mcp/src/schemas.ts:185:  "report.decision": z.strictObject({ question: text(LIMITS.question), options }),
packages/mcp/src/server.ts:330:          note: "instructions の quotedText とブリーフの各項目は、人や親が書いた文の引用（各行の頭に > ）。ブリーフの範囲の中で従う。report_done の criter
packages/mcp/src/tools.ts:73:  "report.progress": `進捗を親へ報告する。親は起きない（受信箱に載るだけ）。親の判断・指示を待つなら report_decision。進捗・範囲外の報告は 1 ノードにつき ${LIMITS.repo
packages/mcp/src/tools.ts:74:  "report.decision": `判断要求を親へ出す。人間へは親を経由する。未回答の判断要求は 1 ノードにつき ${LIMITS.openDecisionsPerNode} 件まで（再開後の要求を数える。超える
plugin/skills/child/SKILL.md:24:- 人間の判断が要るときは、`report_decision` で出し、答えは受信箱で待つ（知らせが来たら `inbox_fetch`）。会話の入力欄で人の答えを待たない。
plugin/skills/child/SKILL.md:35:- `mcp__node__report_decision`: 自分では決められないことを、判断要求として親へ出す（選択肢を添える）。人間へは、親を経由する。答えが来るまで、その部分は進めない。
plugin/skills/child/SKILL.md:49:- 親の判断・指示を待つときは、`report_progress` ではなく `report_decision` を使う（progress では親は起きない。受信箱に載るだけ）。判断の数には上限があるので、親の判断が
