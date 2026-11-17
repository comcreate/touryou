/**
 * HTML 画面の静的な資産（FR_021・IR_003）。依存を増やさず、素の JavaScript で書く（TS の文字列として埋め込むので、ビルドで複製が要らない）。
 *
 * 描画の規則（`ui-assets.test.ts` が走査で守らせる）:
 * - 文字列は `textContent` と `createElement` だけで描く。`innerHTML`・`outerHTML`・`insertAdjacentHTML`・`document.write`・`eval`・`new Function`・
 *   `setAttribute`・`on*` への代入・`location` への代入・`srcdoc` は使わない。
 * - インラインの script・style・イベント属性は置かない（CSP が `'self'` だけを許す）。
 * - 取り消せない操作（最終削除・保管の削除）は、確認の表示で、対象の ID を打ち込ませ、完全に一致するまで送れない（`typedMatches`）。
 *   通信は `callOperation` の 1 か所だけ（事前確認・一覧の読み取りも同じ）。
 * - 操作（判断への回答・拡張要求の判定）は、`<form>` を使わず、ボタンの click で、`POST /v1/request`（`Authorization: Bearer`。cookie は使わない）で送る。
 *   送る前に、必ず確認の表示（内容と回答）を挟む。確認のたびに `requestId` を新しく作り、その確認の間は同じ ID で再送する。
 * - 画面を開くチケット（`#ticket=`）は、読み込んだらすぐ `history.replaceState` でフラグメントを消し、`POST /v1/ui/session` でセッションのトークンに
 *   交換する。セッションのトークン（または貼り付けた人間のトークン）は、メモリにだけ持つ（storage・cookie には置かない）。`#token=` は受け取らない。
 */

import { externalCheckSummaries } from "../external-check.js";

export const UI_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>touryou 状態画面</title>
<link rel="stylesheet" href="/ui/app.css">
</head>
<body>
<p id="live" class="sr" aria-live="polite"></p><header class="top"><h1>touryou 状態画面</h1><span id="status" class="status">未接続</span><span class="tools"><button id="still" class="quiet sm" type="button">動きを止める</button></span></header>
<main>
<section id="auth" hidden>
<h2>人間のトークン</h2>
<p>Mac のターミナルで <code>touryou ui</code> を実行すると（Claude Code では <code>/touryou:ui</code>）、貼り付けなしで開けます。再読み込みしたときも、開き直してください。使えないときは、人間のトークンのファイルの中身を貼り付けてください。トークンはこのページのメモリにだけ置き、保存しません。</p>
<form id="auth-form"><input id="token" name="token" type="password" autocomplete="off" spellcheck="false" aria-label="人間のトークン"><button type="submit">接続</button></form>
</section>
<section id="approvals" class="approvals" hidden></section>
<section id="confirm" class="confirm" hidden></section>
<p id="notice" class="notice" hidden></p>
<section id="view" hidden>
<section class="now" aria-labelledby="now-title"><div id="now-count" class="count" aria-hidden="true">0</div><h2 id="now-title">いまあなたがすること</h2><p id="now-lead" class="lead"></p></section>
<div id="todo" class="todo"></div>
<section class="sec"><h2>やり取り</h2><p class="lead">親子の並びと、上り（子 → 親）・下り（親・人 → 子）のやり取りです。ふだんはいちばん新しいものを出します。上りは、あなたの答えを待つ頼みを先に出します。</p><div id="view-switch" class="seg" role="group" aria-label="見せ方" hidden><button id="show-graph" class="quiet sm" type="button">図</button><button id="show-list" class="quiet sm" type="button">一覧</button></div><div class="board-wrap"><div id="graph" class="board" hidden></div><div id="graph-zoom" class="zoom" role="group" aria-label="図の拡大・縮小" hidden><button id="zoom-in" type="button" aria-label="拡大する" title="拡大する">＋</button><button id="zoom-out" type="button" aria-label="縮める" title="縮める">−</button><button id="zoom-fit" class="fit" type="button" aria-label="全体を見る" title="全体を見る（初めの形に戻す）">全体を見る</button></div></div><div id="graph-legend" class="legend" hidden><span class="lg"><span class="sw up"></span>← 上り（子 → 親。答え待ちの頼みを先に）</span><span class="lg"><span class="sw down"></span>→ 下り（親・人 → 子）</span><span class="lg"><span class="sw a1"></span><span class="sw a3"></span><span class="sw a4"></span>新しいほど濃い</span><span class="lg"><span class="sw wait"></span>あなたの答え待ちのやり取り</span><span class="lg"><span class="edge go"></span>進んでいる</span><span class="lg"><span class="edge turn"></span><span class="edge stall"></span><span class="edge fail"></span>あなたの出番（答え待ち・止まっているかも・失敗）</span><span class="lg"><span class="edge over"></span>終わった</span><span class="lg">箱を押すと、その子のカードへ移ります</span></div><div id="list" class="tlist"></div></section>
<section class="sec"><h2>作業ごとのようす</h2><p class="lead">あなたの出番の作業を先に、ほかは最後に動いた順に並べます。棒は、この 1 時間のやり取りの数（藍はやり取り、柿は答え待ち）。</p><div id="cards" class="cards"></div>
<details id="finished" class="finished"><summary id="finished-summary">終わった作業</summary><div id="finished-cards" class="cards"></div></details></section>
<details class="admin"><summary>管理（まれに使う操作）</summary><p class="warn">ここの操作の多くは、あとから戻せません。押すと、内容を確かめる欄が出ます。取り消せない操作は、対象の ID を打ち込まないと送れません。</p>
<h2>アーカイブした作業の最終削除と、自動の削除の保留</h2><div id="purge"></div>
<h2>捨てた作業の保管</h2><div id="kept"></div></details>
</section>
</main>
<script src="/ui/app.js"></script>
<script src="/ui/graph.js"></script>
</body>
</html>
`;

export const UI_CSS = `:root{color-scheme:light dark;--bg:#f3efe6;--sheet:#fbf9f4;--fg:#22201c;--muted:#5b5650;--line:#d8d0c0;--card:#fbf9f4;--blocking:#a3261c;--failed:#a3261c;--ok:#2f6b45;--ai:#2a4f8f;--ai-2:#4b6492;--ai-3:#6b7891;--kaki:#b85200;--kaki-soft:#fbe6d2;--kiiro:#7a6000;--kiiro-soft:#f4ecc8;--shu:#a3261c;--shu-soft:#f7dfdb;--matsu:#2f6b45;--matsu-soft:#dcebdf;--grid:#e7e0d1;--on-strong:#fff}
@media (prefers-color-scheme: dark){:root{--bg:#16181c;--sheet:#1e2126;--fg:#ebe6dc;--muted:#a39d93;--line:#363a42;--card:#1e2126;--blocking:#ff8c80;--failed:#ff8c80;--ok:#7fc495;--ai:#8fb0ea;--ai-2:#8aa2cc;--ai-3:#8d97aa;--kaki:#ff9a3c;--kaki-soft:#3b2614;--kiiro:#d9b84a;--kiiro-soft:#332b10;--shu:#ff8c80;--shu-soft:#3d1b18;--matsu:#7fc495;--matsu-soft:#18301f;--grid:#23262c;--on-strong:#16181c}}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 "Hiragino Kaku Gothic ProN","Hiragino Sans","Noto Sans JP","Yu Gothic UI",system-ui,sans-serif}
:focus-visible{outline:3px solid var(--ai);outline-offset:2px;border-radius:4px}
.top{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:12px 16px;border-bottom:1px solid var(--line)}
.top h1{font-size:17px;margin:0;letter-spacing:.04em}
.top .tools{margin-left:auto;flex:none;max-width:100%}.tools button{white-space:nowrap}.top h1{flex:none}.top .status{flex:1 1 12em;min-width:0;overflow-wrap:anywhere}
.status{color:var(--muted);font-size:13px}
.status.live::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--matsu);margin-right:6px;vertical-align:middle;animation:breathe 2.4s ease-in-out infinite}
main{padding:0 16px 48px;max-width:1040px;margin:0 auto}
h2{font-size:17px;margin:28px 0 6px}
.lead{margin:0 0 12px;color:var(--muted);font-size:14px}
button{font:inherit;font-size:14px;line-height:1.4;padding:6px 14px;border-radius:999px;border:1px solid var(--line);background:var(--sheet);color:var(--fg);cursor:pointer;transition:transform .12s,border-color .2s}
button:hover{border-color:var(--muted)}button:active{transform:scale(.96)}
button:disabled{opacity:.5;cursor:not-allowed}
button.primary,button.go{background:var(--kaki);border-color:var(--kaki);color:var(--on-strong);font-weight:700}
button.quiet{background:transparent}
button.sm{font-size:12.5px;padding:2px 10px}
button.danger{border-color:var(--shu);color:var(--shu);background:transparent}
button.done{background:var(--matsu);border-color:var(--matsu);color:var(--on-strong)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;margin:-1px;padding:0;border:0}
button.copy{display:inline-flex;align-items:center;justify-content:center;min-width:40px;min-height:34px;padding:4px 10px}
.copy-ico{position:relative;display:inline-block;width:14px;height:14px}
.copy-ico::before,.copy-ico::after{content:"";position:absolute;width:9px;height:10px;border:1.6px solid currentColor;border-radius:2px;box-sizing:border-box}
.copy-ico::before{left:0;top:4px}
.copy-ico::after{left:5px;top:0;background:var(--sheet)}
button.copy:hover .copy-ico::after{background:var(--sheet)}
button.copy.done .copy-ico::after{display:none}
button.copy.done .copy-ico::before{content:"✓";border:0;width:14px;height:14px;left:0;top:-2px;font-size:14px;line-height:14px;font-weight:800;text-align:center}
button.copy.failed{border-color:var(--shu);color:var(--shu)}
code{font-family:"SFMono-Regular",Menlo,Consolas,monospace;font-size:13.5px;word-break:break-all}
.now{margin:24px 0 8px;display:grid;grid-template-columns:auto 1fr;gap:2px 18px;align-items:end}
.now .count{grid-row:span 2;font-size:56px;line-height:1;font-weight:800;color:var(--kaki);min-width:1.2ch;text-align:center;font-variant-numeric:tabular-nums}
.now .count.zero{color:var(--matsu)}
.now .count.bump-a{animation:bump-a .6s cubic-bezier(.3,1.6,.5,1)}.now .count.bump-b{animation:bump-b .6s cubic-bezier(.3,1.6,.5,1)}
.now h2{margin:0;font-size:21px}.now .lead{margin:0}
.todo{display:grid;gap:10px;margin:12px 0 0}
.task{background:var(--sheet);border:1px solid var(--line);border-left:5px solid var(--kaki);border-radius:4px 12px 12px 4px;padding:12px 16px;overflow-wrap:anywhere}
.task.stall{border-left-color:var(--kiiro)}.task.request{border-left-color:var(--muted)}.task.closed{border-left-color:var(--line);opacity:.75}
.task.new,.entry.new{animation:arrive .5s ease-out both}
.who{font-size:13px;color:var(--muted)}.strong{font-weight:700;color:var(--fg)}
.ask{font-size:16px;font-weight:700;margin:2px 0 4px;white-space:pre-wrap}
.cmd{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:var(--bg);border:1px dashed var(--line);border-radius:8px;padding:6px 10px;margin:6px 0}
.empty{padding:14px 16px;border:1px dashed var(--line);border-radius:12px;color:var(--muted);background:var(--sheet);margin:6px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:6px 0;overflow-wrap:anywhere}
.card.blocking{border-left:4px solid var(--blocking)}.card.request{border-left:4px solid var(--muted)}.card.failed{border-left:4px solid var(--failed)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;align-items:start}
.cards .card{margin:0;display:grid;gap:6px;scroll-margin-top:16px}
.card.turn{border-color:var(--kaki);border-left:5px solid var(--kaki)}.card.turn.stall{border-color:var(--kiiro);border-left-color:var(--kiiro)}.card.finished{opacity:.8}
.card.picked{outline:3px solid var(--ai);outline-offset:2px}.card.picked:focus{outline:3px solid var(--ai)}
.card.picked.pa{animation:pickA 1.5s ease-out}.card.picked.pb{animation:pickB 1.5s ease-out}
.ctitle,.card h3{font-weight:700;font-size:15.5px;line-height:1.5;margin:0}
.card.need{border-color:var(--kaki)}
.spark{display:grid;grid-template-columns:repeat(12,1fr);gap:3px;align-items:end;height:34px;border-bottom:1px solid var(--line);padding:0 2px}
.spark .slot{display:flex;align-items:end;justify-content:center;gap:2px;height:100%}
.spark .bar{width:7px;border-radius:2px 2px 0 0;background:var(--ai);transform-origin:bottom;animation:grow .7s cubic-bezier(.2,.9,.3,1.2) both}
.spark .bar.h{background:var(--kaki)}.spark .bar.l1{height:56%}.spark .bar.l2{height:70%}.spark .bar.l3{height:85%}.spark .bar.l4{height:100%}
.flowlist{display:grid;gap:4px;font-size:13.5px}
.flowlist .fl{display:grid;grid-template-columns:20px 1fr auto;gap:6px;align-items:start}
.flowlist .ar{font-weight:800;text-align:center}.flowlist .ar.u{color:var(--ai)}.flowlist .ar.d{color:var(--ai-2)}.flowlist .ar.h{color:var(--kaki)}
.flowlist .t{color:var(--muted);font-size:12px;white-space:nowrap}
.flowlist .fbody{min-width:0;overflow-wrap:anywhere}.flowlist details.fbody>p{margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
@keyframes grow{from{transform:scaleY(0)}to{transform:scaleY(1)}}
.meta{display:flex;flex-wrap:wrap;gap:2px 12px;font-size:12.5px;color:var(--muted)}.meta>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.idline{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.chip{display:inline-block;font-size:12px;font-weight:700;padding:0 8px;border-radius:999px;line-height:1.8;margin-right:4px;background:var(--grid);color:var(--muted)}
.chip.turn{background:var(--kaki-soft);color:var(--kaki)}.chip.stall{background:var(--kiiro-soft);color:var(--kiiro)}.chip.failed,.chip.blocking{background:var(--shu-soft);color:var(--shu)}
.chip.running{background:var(--matsu-soft);color:var(--matsu)}.chip.running::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;margin-right:4px;vertical-align:middle;animation:breathe 1.6s infinite}
.chip.request{background:var(--grid);color:var(--fg)}
.entry{border-top:1px solid var(--line);padding:6px 0 0;font-size:13.5px}
.when{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.flows{font-size:13px;display:grid;gap:2px}
.up{color:var(--ai)}.down{color:var(--ai-2)}.await{color:var(--kaki);font-weight:700}
details>summary{cursor:pointer;font-size:13px;color:var(--muted)}
details[open]>:not(summary){animation:open .3s ease-out both}
.finished{margin-top:12px}
.tlist{border:1px solid var(--line);border-radius:12px;background:var(--sheet);overflow-x:auto}
.trow{display:grid;grid-template-columns:minmax(200px,1.6fr) 140px 1fr 1fr;gap:8px;align-items:center;padding:6px 14px;border-top:1px solid var(--line);font-size:13.5px;min-width:640px}
.trow.thead{border-top:0;font-size:12.5px;color:var(--muted);font-weight:700}
.trow.turn{background:var(--kaki-soft)}.trow.finished{opacity:.7}
.tname{display:flex;align-items:center;gap:6px;min-width:0}.tname .strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tname button{flex:none;white-space:nowrap}
.tag{display:inline-block;font-size:12px;color:var(--muted);margin-right:8px}
.tag.blocking{color:var(--blocking);font-weight:600}.tag.request{font-weight:600}.tag.failed{color:var(--failed);font-weight:600}
.desc{font-size:12.5px;color:var(--muted);margin:2px 0 6px}.irreversible{font-size:12.5px;color:var(--shu);margin:2px 0 6px}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.opts{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0;align-items:center}
textarea{display:block;width:100%;min-height:64px;margin:6px 0;font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
.approvals{position:sticky;top:0;z-index:2;border:2px solid var(--blocking);border-radius:12px;padding:4px 12px 12px;margin:12px 0;background:var(--bg)}.approvals textarea{width:12em;min-height:0;height:2.2em;font:inherit;letter-spacing:.1em;text-transform:uppercase}
.confirm{border:2px solid var(--blocking);border-radius:12px;padding:4px 12px 12px;margin:16px 0;background:var(--card)}
.typed-value{font-family:ui-monospace,monospace;user-select:all;-webkit-user-select:all;background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:0 4px;overflow-wrap:anywhere}
.confirm-title{font-weight:600;margin:10px 0 6px}.confirm-line{margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.error{color:var(--blocking);margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere}.notice{color:var(--ok);margin:12px 0}.notice.bad{color:var(--blocking)}
.admin{margin-top:40px;border:2px solid var(--shu);border-radius:14px;padding:4px 16px 12px;background:var(--sheet)}
.admin>summary{font-size:16px;font-weight:700;color:var(--shu);padding:10px 0}
.admin .warn{margin:0 0 12px;font-size:14px;color:var(--shu);background:var(--shu-soft);border-radius:8px;padding:8px 12px}
.admin h2{font-size:15px}
input,button{font:inherit}
input{padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
form{display:flex;gap:8px;flex-wrap:wrap}input{flex:1;min-width:200px}
[hidden]{display:none!important}
@keyframes breathe{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes bump-a{0%{transform:scale(.6)}100%{transform:scale(1)}}
@keyframes bump-b{0%{transform:scale(.6)}100%{transform:scale(1)}}
@keyframes arrive{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes pickA{0%{box-shadow:0 0 0 0 var(--ai)}35%{box-shadow:0 0 0 8px var(--ai-3)}100%{box-shadow:0 0 0 0 transparent}}
@keyframes pickB{0%{box-shadow:0 0 0 0 var(--ai)}35%{box-shadow:0 0 0 8px var(--ai-3)}100%{box-shadow:0 0 0 0 transparent}}
@keyframes open{from{opacity:0;transform:translateY(-4px)}}
.seg{display:inline-flex;gap:4px;margin:0 0 8px}.seg button[aria-pressed="true"]{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.board{position:relative;height:420px;min-height:180px;max-height:720px;overflow:hidden;border:1px solid var(--line);border-radius:12px;background:var(--sheet);user-select:none;-webkit-user-select:none;touch-action:none}
.gback{position:absolute;left:0;top:0;pointer-events:none}
.gnode{box-sizing:border-box;position:relative;width:220px;height:80px;padding:8px 14px 8px 16px;border:1.5px solid var(--line);border-radius:12px;background:var(--card);display:flex;flex-direction:column;justify-content:center;gap:3px;box-shadow:0 1px 2px rgba(0,0,0,.12)}
.gnode::before{content:"";position:absolute;left:3px;top:10px;bottom:10px;width:3.5px;border-radius:2px;background:var(--ai)}
.gnode.t-turn{border:2.5px solid var(--kaki)}.gnode.t-turn::before{background:var(--kaki)}
.gnode.s-stall{border-color:var(--kiiro)}.gnode.s-stall::before{background:var(--kiiro)}
.gnode.s-fail{border-color:var(--shu)}.gnode.s-fail::before{background:var(--shu)}
.gnode.t-over{opacity:.55;background:var(--bg)}.gnode.t-over::before{background:var(--line)}

.gt{font-size:13.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:14px}
.gr{display:flex;align-items:center;gap:6px;min-width:0}.gic{flex:none}
.role-ic{fill:none;stroke:var(--muted);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.gs{color:var(--muted);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gst{font-size:11.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.st-wait{color:var(--kaki)}.st-stall{color:var(--kiiro)}.st-fail{color:var(--shu)}.st-done,.st-stopped{color:var(--muted)}
.galive{position:absolute;right:10px;top:10px;width:8px;height:8px;border-radius:50%;background:var(--matsu);animation:galive 3s ease-in-out infinite}
.gbadge{position:absolute;right:-10px;top:-10px;min-width:24px;height:24px;padding:0 4px;box-sizing:border-box;border-radius:12px;background:var(--kaki);color:var(--on-strong);font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center}
.glink{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}

.trunk{fill:none;stroke:var(--ai-3);stroke-width:4;stroke-linecap:round;opacity:.5}
.twig{fill:none;stroke:var(--muted);stroke-width:1.5;stroke-dasharray:2 5;opacity:.6}
.line{fill:none;stroke:var(--ai);stroke-width:2.5;stroke-dasharray:6 8}.tip{fill:var(--ai)}.port{fill:var(--ai);stroke:var(--sheet);stroke-width:2}
.line.down{stroke:var(--ai-2)}.tip.down,.port.down{fill:var(--ai-2)}
.line.g-sent{animation:gflow .8s linear infinite}.line.g-unknown{animation:gflow 3s linear infinite;stroke-dasharray:3 6}.line.g-delivered{animation:gflow 2.4s linear infinite}
.line.a1{stroke-width:3}.line.a2{opacity:.85}.line.a3{opacity:.65}.line.a4{opacity:.45}.tip.a3,.port.a3{opacity:.65}.tip.a4,.port.a4{opacity:.45}
.line.wait{stroke:var(--kaki);stroke-width:3.5;opacity:1}.tip.wait,.port.wait{fill:var(--kaki)}
.line.over,.tip.over,.port.over,.line.g-done{opacity:.45}
.mlabel,.mstage{paint-order:stroke;stroke:var(--sheet);stroke-width:3px;stroke-linejoin:round}
.mlabel{font-size:11.5px;font-weight:700;fill:var(--fg)}.mstage{font-size:11px;fill:var(--muted)}.mlabel.wait,.mstage.wait{fill:var(--kaki)}.mlabel.over,.mstage.over{opacity:.6}
.gnode{cursor:pointer;transition:box-shadow .15s}.gnode:focus-visible{outline:3px solid var(--ai);outline-offset:2px}.gnode:hover{box-shadow:0 0 0 3px var(--grid)}
.board .glink,.board .gback{transition:opacity .15s}.board.hot .glink{opacity:.18}.board.hot .lit .glink{opacity:1}.board.g-instant .glink,.board.g-instant .gback,.board.g-instant .gnode{transition:none}
.board-wrap{position:relative}.zoom{position:absolute;right:10px;top:10px;display:flex;gap:4px;z-index:2}.zoom button{width:34px;height:34px;padding:0;border-radius:50%;font-size:18px;line-height:1;background:var(--sheet);color:var(--fg);border:1px solid var(--line)}.zoom button.fit{width:auto;padding:0 12px;border-radius:999px;font-size:13px}.zoom button:focus-visible{outline:3px solid var(--ai);outline-offset:2px}
.legend{display:flex;flex-wrap:wrap;gap:4px 16px;margin:8px 0 0;font-size:12.5px;color:var(--muted)}.lg{display:inline-flex;align-items:center;gap:4px}
.sw{display:inline-block;width:22px;height:0;border-top:2.5px dashed var(--ai)}.sw.down{border-top-color:var(--ai-2)}.sw.a1{border-top-width:3px}.sw.a3{opacity:.65}.sw.a4{opacity:.45}.sw.wait{border-top:3.5px dashed var(--kaki)}
.edge{display:inline-block;width:4px;height:14px;border-radius:2px;background:var(--ai)}.edge.turn{background:var(--kaki)}.edge.stall{background:var(--kiiro)}.edge.fail{background:var(--shu)}.edge.over{background:var(--line)}
.pip{position:absolute;left:0;top:0;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:var(--ai);offset-rotate:0deg;animation:gtravel 1.6s linear infinite}
@keyframes galive{0%,100%{opacity:1}50%{opacity:.45}}
@keyframes gflow{to{stroke-dashoffset:-14}}@keyframes gtravel{from{offset-distance:0%}to{offset-distance:100%}}
.still *,.still *::before{animation:none!important;transition:none!important}
@media (prefers-reduced-motion: reduce){*,*::before{animation:none!important;transition:none!important}}
@media (max-width:640px){.now .count{font-size:44px}.now h2{font-size:18px}.top .tools{margin-left:0}}
`;

// 根に出る、Desktop の子を人が確かめる依頼（daemon の再起動のあとの整合。external-check.ts）の文面の先頭。画面は、これを「停止の代行依頼」と同じ扱いにする
// 先頭の 40 文字だけを埋め込む（見分けるには足りる。文面の末尾の文書名などを、画面の資産に入れない）
const EXTERNAL_CHECK_PREFIXES = JSON.stringify(externalCheckSummaries().map((x) => x.slice(0, 40)));

export const UI_JS = `'use strict';
(function () {
  // 最初に、フラグメントのチケット（touryou ui が付ける、60 秒・1 回だけのもの）を取り出して、アドレスから消す（履歴に残さない）。
  // 長く使える人間のトークンは、URL では受け取らない（#token= は効かない）。
  var token = '';
  var ticket = '';
  // 今のトークンが、チケットから交換した画面のセッションか（切れたときの案内を変える）
  var viaSession = false;
  var hash = window.location.hash;
  if (hash.length > 1) {
    var m = /(?:^|[#&])ticket=([A-Za-z0-9_-]{43})(?:&|$)/.exec(hash);
    if (m) ticket = m[1];
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  var TAGS = { div: true, span: true, p: true, button: true, textarea: true, details: true, summary: true, code: true, h3: true };
  var TEXT_MAX = 4000;
  var FORBIDDEN = /[\\p{Cc}\\p{Cf}]/u;
  var STATE_NAMES = { pending: '起動を待っている', running: '動いている', waiting: '待っている', done: '済んだと報告（確かめ待ち）', verified: '受け入れた', stopping: '止めている', stopIncomplete: '止まりきっていない', stopped: '止めた', reclaimable: '片付けられる', archived: 'アーカイブした' };
  var ROLE_NAMES = { integrator: '統合', implement: '作業', review: 'レビュー', investigate: '調べ', merge: 'まとめ' };
  // 受信箱の項目の種類（利用者の言葉）。「止まっているかも」は、daemon の知らせ（stall）があるときだけ（画面で推し量らない）
  var KIND_NAMES = { decision: '判断を求む', answer: '答え', violation: '止められた操作', failure: 'うまくいかなかった', stopIncomplete: '止まりきっていない', done: '済んだ', progress: '進み具合', info: '知らせ', digest: 'まとめ' };
  var BAND_NAMES = { turn: 'あなたの出番', running: '進んでいる', finished: '終わった' };
  var FLOW_KIND_NAMES = { instruction: '指示', report: '報告', done: '済んだの報告', decision: '判断を求む', extension: '範囲の頼み', answer: '答え', approved: '許可', rejected: '却下', split: '切り出し' };
  var EXTERNAL_CHECK_PREFIXES = ${EXTERNAL_CHECK_PREFIXES};
  var PRIORITY_NAMES = { blocking: '要判断', failed: '失敗', completed: '完了', progress: '進捗', info: '情報' };
  var POLL_MS = 2000;
  var SAFETY_MS = 30000;
  var THROTTLE_MS = 1000;
  var BACKOFF_MIN = 1000;
  var BACKOFF_MAX = 300000;
  // 裏のタブ: 隠れてこの時間たったら購読を閉じ（ほかのタブに枠を空ける）、ポーリングも間を空ける。
  // 利用者の決めで、枠が埋まったときは裏のタブを先に譲る。そのため、裏のタブはすぐに（チラつかない程度の短い待ちで）閉じ、
  // 枠を持たないようにする。枠が埋まって外れるのは、表のタブのうちいちばん古いもの（daemon の作りは #114 のまま）
  var HIDE_CLOSE_MS = 4000;
  var HIDDEN_POLL_MS = 30000;
  // 429 がこの回数続いたら、購読の再試行をやめる（見えたとき・フォーカスが来たときだけ試す。コンソールを埋めない）
  var TOO_MANY_MAX = 3;

  var statusEl = document.getElementById('status');
  var authEl = document.getElementById('auth');
  var viewEl = document.getElementById('view');
  var timer = null;
  var lastView = null;
  var sseUp = false;
  var generation = 0;
  var backoff = BACKOFF_MIN;
  var lastRefreshAt = 0;
  var refreshing = false;
  var again = false;
  var controller = null;
  var throttleTimer = null;
  var drafts = new Map();
  var pending = null;
  var retryMs = 0;
  // 購読の様子: live（つながっている）・connecting・retrying（切れて、待ってから張り直す）・paused（裏に回って閉じた）・
  // replaced（ほかのタブに枠を譲った）・gaveUp（429 が続いた）。paused・replaced・gaveUp の間は、自分からは張り直さない
  var sseState = 'idle';
  var tooManyCount = 0;
  var reconnectTimer = null;
  var hideTimer = null;

  function name(table, key) { return Object.hasOwn(table, key) ? table[key] : key; }
  // 時刻（ISO 8601）を、手元の時刻と経過で出す。今日なら「14:05（3 分前）」、ほかの日は「11/16 14:05（1 日前）」。読めなければ ''。
  function timeText(iso, nowMs) {
    var t = typeof iso === 'string' ? Date.parse(iso) : NaN;
    if (!(t === t)) return '';
    var d = new Date(t);
    var today = new Date(nowMs);
    var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    var sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    return (sameDay ? '' : (d.getMonth() + 1) + '/' + d.getDate() + ' ') + hm + '（' + agoText(nowMs - t) + '）';
  }
  function agoText(ms) {
    var m = Math.floor(ms / 60000);
    if (m < 1) return 'いま';
    if (m < 60) return m + ' 分前';
    if (m < 1440) return Math.floor(m / 60) + ' 時間前';
    return Math.floor(m / 1440) + ' 日前';
  }
  // やり取りの段の言葉。届いたかの記録がない（deliveryUnknown）・推定（doneInferred）は、そう言う
  function stageText(f) {
    if (f.stage === 'sent') return f.deliveryUnknown ? '送った（届いたかは分からない）' : '送った（まだ届いていない）';
    if (f.stage === 'delivered') return '届いた（返事を待っている）';
    if (f.stage === 'done') return f.doneInferred ? '済んだ（推定）' : '済んだ';
    return '';
  }
  // 止まっているかもしれない子を開くコマンド。CLI の子は --name <ノード ID> で起動しているので、claude attach で開ける。
  // Desktop の子（stopDelegated）と、ID の形でないものは ''（コマンドを出さない）
  function attachCommand(n) {
    if (!n || n.stopDelegated === true || typeof n.id !== 'string' || !ID_RE.test(n.id)) return '';
    return 'claude attach ' + n.id;
  }
  // ノードの呼び名（題がなければ ID）。
  function nodeLabel(n, max) { return n && typeof n.title === 'string' && n.title !== '' ? cleanText(n.title, max) : n ? n.id : ''; }
  function el(tag, cls, text) {
    if (!Object.hasOwn(TAGS, tag)) throw new Error('tag');
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  // 入力欄。id・name を付ける（ブラウザの自動入力・支援技術が欄を区別できるように）。id はページの中で一意にする。
  var fieldSeq = 0;
  function field(fieldName) {
    var e = el('textarea', '');
    fieldSeq += 1;
    e.name = fieldName;
    e.id = fieldName + '-' + fieldSeq;
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function setStatus(text) { statusEl.textContent = text; statusEl.className = 'status'; }
  function showAuth(show) { authEl.hidden = !show; viewEl.hidden = show; }

  // ---- 操作（判断への回答）----
  function hasForbidden(text) {
    return Array.from(text).some(function (ch) { return ch !== '\\t' && ch !== '\\n' && FORBIDDEN.test(ch); });
  }
  // 自由入力の回答の検査。制御文字・書式制御文字は、サーバーの検証と同じ規則（タブ・改行は可）。上限（TEXT_MAX）は、サーバー（64 KiB）より厳しい。問題がなければ ''。
  function checkAnswer(text) {
    if (text.trim() === '') return '回答が空です（空白だけは送れません）';
    var n = Array.from(text).length;
    if (n > TEXT_MAX) return '長すぎます（' + n + ' 文字。' + TEXT_MAX + ' 文字以下）';
    if (hasForbidden(text)) return '使えない文字（制御文字・書式制御文字）を含んでいます';
    return '';
  }
  // 通知。bad が真なら、失敗として赤で出す。
  function notice(text, bad) {
    var n = document.getElementById('notice');
    n.textContent = text;
    n.className = bad ? 'notice bad' : 'notice';
    n.hidden = !text;
    // 通知は、ページの上にある。押したボタンが下にあっても、結果が見えるように、見える所まで動かす
    if (text) n.scrollIntoView({ block: 'nearest' });
  }
  // 429 のとき、送り直すまで待つ秒数（Retry-After。なければ 5 秒）。それ以外は 0。
  function waitSecondsOf(r) {
    return r.status === 429 ? (r.retry > 0 ? r.retry : 5) : 0;
  }
  function describeFailure(r) {
    var e = r.body && r.body.error;
    var base = e && typeof e.code === 'string' ? e.code + ': ' + String(e.cause || '').slice(0, 300) : 'HTTP ' + r.status;
    if (r.status === 429) base += '（' + (r.retry > 0 ? r.retry + ' 秒' : 'しばらく') + '待ってから、もう一度送る）';
    var hint = failureHint(e && e.code);
    // 先端が変わった（または確かめられない）ときは、同じ内容では、何度送っても通らない。確かめ直させる
    if (hint) return base + '\\n' + hint;
    // 再送して意味があるのは、待てば通りうるもの（429。ネットワークの失敗は、sendPending の catch）だけ。判断の失敗（4xx）は、同じ内容では、結果が変わらない
    if (r.status === 429) return base + '\\n同じ内容で、もう一度送れます（同じ要求として扱われ、二重には実行されません）。';
    return base + '\\n同じ内容を送り直しても、結果は変わりません。「戻る」で、状態を確かめてから、やり直してください。';
  }
  // 失敗の種類ごとの案内。なければ ''。
  function failureHint(code) {
    if (code === 'confirmationRequired') return 'まだ実行していません。ページのいちばん上の「確認待ち」の欄に、daemon を起動した端末に出たコードを打って、確認してください。';
    if (code === 'tipMismatch' || code === 'tipUnknown') return '表示したあとで、先端が変わった（または確かめられない）ため、何も指示していません。もう一度、「破棄して回収を指示…」から、内容を確かめ直してください。';
    return '';
  }
  function renderConfirm() {
    var box = document.getElementById('confirm');
    clear(box);
    if (!pending) { box.hidden = true; return; }
    box.hidden = false;
    box.appendChild(el('div', 'confirm-title', pending.title + '（確認）'));
    pending.lines.forEach(function (line) {
      var row = el('div', 'confirm-line');
      row.appendChild(el('span', 'tag', line[0]));
      row.appendChild(el('span', '', line[1]));
      box.appendChild(row);
    });
    if (pending.blocked) box.appendChild(el('p', 'error', pending.blocked));
    var typedBox = null;
    if (pending.typed !== undefined && !pending.blocked) {
      // 長い ID を手で打たなくてよいように、文字列は、1 回のクリックで全体が選ばれる（コピーして、欄に貼り付けられる）
      var typedLine = el('p', '', '取り消せません。確認のため、次の文字列を、そのまま打ち込むか、コピーして貼り付けてください: ');
      typedLine.appendChild(el('span', 'typed-value', pending.typed));
      box.appendChild(typedLine);
      typedBox = field('typed');
      typedBox.rows = 1;
      typedBox.maxLength = 300;
      typedBox.value = pending.typedValue;
      typedBox.disabled = pending.sending;
      box.appendChild(typedBox);
    }
    if (pending.error) box.appendChild(el('p', 'error', pending.error));
    var actions = el('div', 'actions');
    // 429 のときは、Retry-After の秒数のあいだ、送れない（時間が来たら、自動で、押せるようになる）
    var left = pending.retryAt ? Math.ceil((pending.retryAt - Date.now()) / 1000) : 0;
    var waiting = left > 0;
    var send = el('button', 'primary', pending.sending ? '送信中…' : waiting ? 'あと ' + left + ' 秒待つ' : 'この内容で送る');
    var refreshSend = function () {
      send.disabled = pending.sending || waiting || Boolean(pending.blocked) || (pending.typed !== undefined && !typedMatches(pending.typed, pending.typedValue));
    };
    refreshSend();
    if (typedBox) {
      var current = pending;
      typedBox.addEventListener('input', function () {
        if (pending !== current) return;
        current.typedValue = typedBox.value;
        refreshSend();
      });
    }
    if (waiting) {
      var shown = pending;
      window.setTimeout(function () { if (pending === shown) renderConfirm(); }, 500);
    }
    send.addEventListener('click', sendPending);
    var back = el('button', '', '戻る');
    back.disabled = pending.sending;
    back.addEventListener('click', function () { pending = null; renderConfirm(); });
    actions.appendChild(send);
    actions.appendChild(back);
    box.appendChild(actions);
    // 開いた直後だけ、確認の欄まで動かして、フォーカスを移す（欄はページの上にあるので、下のボタンを押したとき、何も起きないように見えないように）
    if (pending.justOpened) {
      pending.justOpened = false;
      box.scrollIntoView({ block: 'start' });
      var target = typedBox || (send.disabled ? back : send);
      target.focus({ preventScroll: true });
    }
  }
  // 確認を出す。確認のたびに requestId を新しく作る（その確認の間は、同じ ID で再送する）。
  // done: 成功の通知（文字列、または、結果の値を受け取って文字列を返す関数）。opts.typed: 打ち込ませる文字列（取り消せない操作）。opts.blocked: 送れない理由（出して、送らせない）。opts.after: 成功のあとに呼ぶ関数。
  function openConfirm(title, lines, operation, params, done, opts) {
    if (pending && pending.sending) return;
    if (!window.crypto || !window.crypto.randomUUID) { notice('このブラウザでは、操作できません（crypto.randomUUID がありません）', true); return; }
    notice('');
    var o = opts || {};
    pending = { title: title, lines: lines, operation: operation, params: params, done: done, requestId: window.crypto.randomUUID(), sending: false, error: '', retryAt: 0, typed: o.typed, typedValue: '', blocked: o.blocked || '', after: o.after, justOpened: true };
    renderConfirm();
  }
  // 打ち込みの確認: 打ち込む文字列が決まっていて、入力が完全に一致するときだけ（前後の空白・大文字小文字・全角の違いは、すべて不一致）。
  function typedMatches(typed, input) {
    return typeof typed === 'string' && typed !== '' && typeof input === 'string' && input === typed;
  }
  // 通信は、ここだけ。要求の識別子は、呼び出し側が決める（確認の間は同じ ID で再送する）。401 はトークンを破棄して null。
  function callOperation(operation, params, requestId) {
    return fetch('/v1/request', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: requestId, operation: operation, params: params })
    })
      .then(function (res) {
        if (res.status === 401) { rejectToken('トークンが正しくありません'); return null; }
        var retry = res.status === 429 ? parseInt(res.headers.get('retry-after') || '', 10) : 0;
        return res.json().then(
          function (body) { return { status: res.status, body: body, retry: retry }; },
          function () { return { status: res.status, body: null, retry: retry }; }
        );
      });
  }
  // 読み取りの操作（事前確認・一覧）の結果。{ ok: true, value } か { ok: false, error: { code, cause, status } }（通知は出さない。
  // 失敗の種類（tipMismatch など）を、呼び出し側が区別できる）。ネットワークの失敗は code が 'network'、401 はトークンを破棄して null。
  function readOperationResult(operation, params) {
    if (!window.crypto || !window.crypto.randomUUID) return Promise.resolve({ ok: false, error: { code: 'unsupported', cause: 'このブラウザでは、操作できません（crypto.randomUUID がありません）', status: 0 } });
    return callOperation(operation, params, window.crypto.randomUUID())
      .then(function (r) {
        if (r === null) return null;
        if (r.status === 200 && r.body && r.body.ok === true) return { ok: true, value: r.body.value };
        var e = r.body && r.body.error;
        return { ok: false, error: { code: e && typeof e.code === 'string' ? e.code : 'http', cause: e ? String(e.cause || '').slice(0, 300) : 'HTTP ' + r.status, status: r.status } };
      })
      .catch(function () { return { ok: false, error: { code: 'network', cause: 'daemon に接続できません', status: 0 } }; });
  }
  // 読み取りの操作。成功なら値、失敗なら通知（赤）に理由を出して null。
  function readOperation(operation, params) {
    return readOperationResult(operation, params).then(function (r) {
      if (r === null) return null;
      if (r.ok) return r.value;
      notice('失敗: ' + r.error.code + ': ' + r.error.cause, true);
      return null;
    });
  }
  function sendPending() {
    var p = pending;
    if (!p || p.sending) return;
    if (p.blocked || (p.typed !== undefined && !typedMatches(p.typed, p.typedValue))) return; // 打ち込みが一致しない・送れない理由があるときは、送らない
    p.sending = true;
    p.error = '';
    renderConfirm();
    callOperation(p.operation, p.params, p.requestId)
      .then(function (r) {
        p.sending = false;
        if (r === null) { pending = null; renderConfirm(); return; }
        if (r.status === 200 && r.body && r.body.ok === true) {
          pending = null;
          renderConfirm();
          notice(typeof p.done === 'function' ? p.done(r.body.value) : p.done);
          if (p.after) p.after();
          refresh();
          return;
        }
        p.error = describeFailure(r);
        var wait = waitSecondsOf(r);
        p.retryAt = wait > 0 ? Date.now() + wait * 1000 : 0;
        if (pending === p) renderConfirm();
      })
      .catch(function () {
        p.sending = false;
        p.error = '送れませんでした（daemon に接続できません）。\\n同じ内容で、もう一度送れます（同じ要求として扱われ、二重には実行されません）。';
        if (pending === p) renderConfirm();
      });
  }

  // 判断の頼み（いまあなたがすること）。box は呼び出し側が空にしてから渡す。byId: ノード ID から表示モデルのノード
  function renderDecisions(list, box, byId) {
    var active = document.activeElement;
    var keep = active && active.dataset ? active.dataset.draft : '';
    var areas = new Map();
    var live = new Set();
    var CLOSED_REASON = { discarded: '破棄を決めた子のため、答えても届きません' };
    list.forEach(function (d) {
      live.add(d.id);
      var closed = d.closedReason;
      var card = taskCard(closed ? 'task closed' : 'task', 'd-' + d.id, closed ? '閉じた判断' : '判断を求む', closed ? '' : 'turn', byId.get(d.nodeId), d.nodeId);
      var question = d.question || '（質問の記録なし）';
      card.appendChild(el('div', 'ask', question));
      // 閉じた判断は、理由を示し、回答の操作を出さない（答えても届かないため）。
      if (closed) {
        card.appendChild(el('p', 'error', CLOSED_REASON[closed] || '閉じています'));
        box.appendChild(card);
        return;
      }
      var opts = el('div', 'opts');
      var anyCut = d.optionsCut;
      d.options.forEach(function (o) {
        var b = el('button', '', o.text);
        // 切った・文字を除いた選択肢は、そのままでは choice に送れない（別の文字列を送ってしまう）。ボタンを無効にして、自由入力を促す
        b.disabled = o.truncated;
        if (o.truncated) anyCut = true;
        b.addEventListener('click', function () {
          openConfirm('判断への回答', [['ノード', d.nodeId], ['判断', question], ['回答（選択肢）', o.text]], 'decision.answer', { decisionId: d.id, choice: o.text }, answerDoneText);
        });
        opts.appendChild(b);
      });
      card.appendChild(opts);
      if (anyCut) card.appendChild(el('p', 'error', '長すぎる（または、表示できない文字を含む・数が多い）選択肢があります。長すぎるため、自由入力で回答してください'));
      var area = field('answer');
      area.maxLength = TEXT_MAX;
      area.placeholder = '自由入力で回答（' + TEXT_MAX + ' 文字まで）';
      area.dataset.draft = d.id;
      area.value = drafts.get(d.id) || '';
      area.addEventListener('input', function () { drafts.set(d.id, area.value); });
      areas.set(d.id, area);
      card.appendChild(area);
      var problem = el('p', 'error', '');
      problem.hidden = true;
      var free = el('button', '', '自由入力で回答する');
      free.addEventListener('click', function () {
        var text = area.value;
        var why = checkAnswer(text);
        problem.textContent = why;
        problem.hidden = why === '';
        if (why !== '') return;
        openConfirm('判断への回答', [['ノード', d.nodeId], ['判断', question], ['回答（自由入力）', text]], 'decision.answer', { decisionId: d.id, text: text }, answerDoneText);
      });
      card.appendChild(free);
      card.appendChild(problem);
      box.appendChild(card);
    });
    drafts.forEach(function (_v, id) { if (!live.has(id)) drafts.delete(id); });
    if (keep && areas.has(keep)) {
      var ta = areas.get(keep);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }

  // 拡張要求の判定（scope.decide）。許可する対象は、daemon が記録済みの対象をそのまま使う（画面の表示と一致する）。
  // 対象が隠れている（絶対パス・.. ・制御文字・長すぎる、など）ときは、承認・切り出しをさせない（却下だけ）。
  var DECISION_LABELS = { approve: '承認', reject: '却下', split: '切り出し' };
  var DECISION_NOTES = { split: 'この対象は許可しない。子には、作業を切り出して進めるよう通知される' };
  var KIND_LABELS = { write: '書き込みの場所', command: 'コマンド' };
  function renderExtensions(list, box, byId) {
    list.forEach(function (x) {
      var card = taskCard('task', 'x-' + x.id, '範囲を広げる頼み', 'turn', byId.get(x.nodeId), x.nodeId);
      card.appendChild(el('div', 'ask', (x.kind ? name(KIND_LABELS, x.kind) + 'を広げたい: ' : '') + x.reason));
      card.appendChild(el('p', 'desc', '承認すると、子はこの対象を使えるようになります。却下すると、子には範囲の外と伝わり、別のやり方を考えます。切り出すと、別の作業として分けます。'));
      card.appendChild(el('div', 'confirm-line', x.targetHidden ? '対象: （表示できない）' : '対象: ' + x.target));
      var opts = el('div', 'opts');
      ['approve', 'reject', 'split'].forEach(function (decision) {
        var b = el('button', '', DECISION_LABELS[decision]);
        b.disabled = x.targetHidden && decision !== 'reject';
        b.addEventListener('click', function () {
          openConfirm(
            '範囲の頼みの' + DECISION_LABELS[decision],
            [['ノード', x.nodeId], ['種類', x.kind ? name(KIND_LABELS, x.kind) : '（不明）'], ['対象', x.targetHidden ? '（表示できない）' : x.target], ['理由', x.reason], ['判定', DECISION_LABELS[decision] + (Object.hasOwn(DECISION_NOTES, decision) ? '（' + DECISION_NOTES[decision] + '）' : '')]],
            'scope.decide',
            { extensionId: x.id, decision: decision },
            '範囲の頼みを' + DECISION_LABELS[decision] + 'しました'
          );
        });
        opts.appendChild(b);
      });
      card.appendChild(opts);
      if (x.targetHidden) card.appendChild(el('p', 'error', '対象に、表示できない文字・絶対パス・.. ・長すぎる値などが含まれるため、承認・切り出しはできません（却下だけできます）。子に、相対パス・単純なコマンドで要求し直すよう依頼してください。'));
      box.appendChild(card);
    });
  }

  // 停止を親に代行してもらうノード（stopDelegated。Desktop の子・CLI の子）の停止未完了は、失敗ではなく、決まった手順の依頼（親が止めて、「止めたと宣言」する）。
  // 根に出る、Desktop の子を人が確かめる依頼（daemon の再起動のあとの整合）も、同じ扱い（文面の先頭で見分ける）。
  function isStopRequest(i, delegated) {
    if (i.kind !== 'stopIncomplete') return false;
    if (delegated.has(i.nodeId)) return true;
    var summary = typeof i.summary === 'string' ? i.summary : '';
    return EXTERNAL_CHECK_PREFIXES.some(function (p) { return summary.indexOf(p) === 0; });
  }
  // 受信箱の帯（色）と名前。停止の代行依頼は、赤の「失敗」でなく「停止の代行依頼」。
  function inboxBand(i, delegated) {
    if (isStopRequest(i, delegated)) return { cls: 'request', label: '停止の代行依頼' };
    var cls = i.priority === 'blocking' || i.priority === 'failed' ? i.priority : '';
    return { cls: cls, label: name(PRIORITY_NAMES, i.priority) };
  }
  // 前に描いた項目の印（新しく来たものだけ、入ってくる動きを付ける。最初の描画では付けない）
  var seenItems = null;
  var nextSeen = new Set();
  function markNew(e, key) {
    nextSeen.add(key);
    if (seenItems !== null && !seenItems.has(key)) e.className += ' new';
  }
  // たたむ欄。描き直しても、開いた欄は開いたままにする（key ごとに覚える）
  var openFolds = new Set();
  function fold(key, label) {
    var d = el('details', '');
    d.open = openFolds.has(key);
    d.addEventListener('toggle', function () { if (d.open) openFolds.add(key); else openFolds.delete(key); });
    d.appendChild(el('summary', '', label));
    return d;
  }
  // いまあなたがすることの 1 件の枠。誰からか（題・役割・最後の動き）を先頭に出す
  function taskCard(cls, key, label, chip, n, nodeId) {
    var card = el('div', cls);
    markNew(card, key);
    var who = el('div', 'who');
    who.appendChild(el('span', 'chip ' + chip, label));
    who.appendChild(el('span', 'strong', n ? nodeLabel(n, 60) : nodeId));
    if (n) who.appendChild(el('span', '', '（' + name(ROLE_NAMES, n.role) + '）' + (n.lastActivityAt ? '・最後の動き ' + timeText(n.lastActivityAt, Date.now()) : '')));
    card.appendChild(who);
    return card;
  }
  // 写すボタン。写せないとき（クリップボードが使えない）は、そう言う（文字は欄にあるので、手で選べる）
  // 写すボタン（クリップボードのアイコン。四角が 2 つずれて重なった形を CSS で描く。文字は出さず、名前は aria-label と title）。
  // 押したら、済みの形（✓）にして、読み上げにも伝える（#live。aria-live）。数秒で元に戻す
  var COPY_BACK_MS = 2500;
  function announce(msg) {
    var live = document.getElementById('live');
    live.textContent = '';
    live.textContent = msg;
  }
  function copyButton(text) {
    var b = el('button', 'sm copy');
    b.appendChild(el('span', 'copy-ico'));
    var name = function (label, cls) { b.ariaLabel = label; b.title = label; b.className = cls; };
    name('写す', 'sm copy');
    var back = null;
    b.addEventListener('click', function () {
      var said = function (ok) {
        name(ok ? '写しました' : '写せません（文字を選んでコピーしてください）', ok ? 'sm copy done' : 'sm copy failed');
        announce(ok ? '写しました' : '写せません。文字を選んでコピーしてください');
        if (back !== null) window.clearTimeout(back);
        back = window.setTimeout(function () { back = null; name('写す', 'sm copy'); }, COPY_BACK_MS);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { said(true); }, function () { said(false); });
      else said(false);
    });
    return b;
  }
  function delegatedOf(nodes) {
    var delegated = new Set();
    nodes.forEach(function (n) { if (n.stopDelegated === true) delegated.add(n.id); });
    return delegated;
  }
  // いまあなたがすること: 判断の頼み・範囲の頼み・止まっているかも（daemon の知らせだけ）・停止の代行依頼。数と一覧
  var countFlip = false;
  var lastCount = -1;
  function renderTodo(view, byId) {
    var box = document.getElementById('todo');
    clear(box);
    var open = view.decisions.filter(function (d) { return !d.closedReason; });
    var closed = view.decisions.filter(function (d) { return d.closedReason; });
    renderDecisions(open, box, byId);
    renderExtensions(view.extensions, box, byId);
    var delegated = delegatedOf(view.nodes);
    var n = open.length + view.extensions.length;
    view.inbox.forEach(function (i) {
      var node = byId.get(i.nodeId);
      if (i.stall === true) {
        n += 1;
        var card = taskCard('task stall', 'i-' + i.id, '止まっているかも', 'stall', node, i.nodeId);
        card.appendChild(el('div', 'ask', 'daemon が、この子は入力を待って止まっているかもしれないと知らせています。子の画面を開いて確かめてください。'));
        if (i.at) card.appendChild(el('div', 'when', '知らせ: ' + timeText(i.at, Date.now())));
        var cmd = attachCommand(node);
        if (cmd) {
          var row = el('div', 'cmd');
          row.appendChild(el('span', '', '端末に貼って、子の画面を開きます:'));
          row.appendChild(el('code', '', cmd));
          row.appendChild(copyButton(cmd));
          card.appendChild(row);
        } else {
          card.appendChild(el('p', 'desc', 'この子は Desktop で動いています。Desktop で、この題の子を開いて確かめてください。'));
        }
        box.appendChild(card);
      } else if (isStopRequest(i, delegated)) {
        n += 1;
        var req = taskCard('task request', 'i-' + i.id, '停止の代行依頼', 'request', node, i.nodeId);
        req.appendChild(el('div', 'ask', delegated.has(i.nodeId) ? 'daemon は、この子を直接止められません。親（または人）が止めてから、「止めたと宣言…」で知らせてください。' : 'daemon は、Desktop の子の状態を確かめられません。Desktop で子ごとに確かめ、止まっていれば、その子の「止めたと宣言…」で知らせてください（手順は、docs の「Desktop の子」の説明）。'));
        if (node && node.state === 'stopIncomplete' && node.stopDelegated === true && ID_RE.test(node.id)) req.appendChild(confirmStoppedBox(node.id));
        box.appendChild(req);
      }
    });
    renderDecisions(closed, box, byId);
    if (n === 0) box.appendChild(el('p', 'empty', '子は自分で進めています。新しい問いや頼みが来ると、ここに出ます。'));
    var countEl = document.getElementById('now-count');
    countEl.textContent = String(n);
    var cls = n === 0 ? 'count zero' : 'count';
    if (lastCount !== -1 && n !== lastCount) { countFlip = !countFlip; cls += countFlip ? ' bump-a' : ' bump-b'; }
    countEl.className = cls;
    lastCount = n;
    document.getElementById('now-title').textContent = n ? 'いまあなたがすること（' + n + ' 件）' : 'いま、あなたがすることはありません';
    document.getElementById('now-lead').textContent = n ? '答えると、その子の作業が先へ進みます。' : '';
  }

  // 作業ごとのようす: 子 1 つを 1 枚のカードに。あなたの出番を先に、ほかは最後に動いた順。終わった作業は、たたんだ欄へ
  function byActivity(a, b) {
    var ta = a.lastActivityAt || '';
    var tb = b.lastActivityAt || '';
    return ta < tb ? 1 : ta > tb ? -1 : 0;
  }
  function renderCards(view, byId) {
    var box = document.getElementById('cards');
    var fin = document.getElementById('finished-cards');
    clear(box);
    clear(fin);
    var delegated = delegatedOf(view.nodes);
    var items = new Map();
    view.inbox.forEach(function (i) {
      if (!items.has(i.nodeId)) items.set(i.nodeId, []);
      items.get(i.nodeId).push(i);
    });
    var turn = view.nodes.filter(function (n) { return n.band === 'turn'; }).sort(byActivity);
    var running = view.nodes.filter(function (n) { return n.band !== 'turn' && n.band !== 'finished'; }).sort(byActivity);
    var finished = view.nodes.filter(function (n) { return n.band === 'finished'; }).sort(byActivity);
    turn.concat(running).forEach(function (n) { box.appendChild(nodeCard(n, byId, items.get(n.id) || [], view.flows, delegated)); });
    finished.forEach(function (n) { fin.appendChild(nodeCard(n, byId, items.get(n.id) || [], view.flows, delegated)); });
    if (!turn.length && !running.length) box.appendChild(el('p', 'empty', view.nodes.length ? '動いている作業はありません' : '作業はまだありません'));
    document.getElementById('finished').hidden = finished.length === 0;
    document.getElementById('finished-summary').textContent = '終わった作業（' + finished.length + ' 件。たたんでいます）';
  }
  // 子ごとの状態の札（図の箱の 3 行目と同じ印と言葉。graph-model.ts の STATUS_TEXT・RUN_TEXT と同じ決め方・同じ言葉。試験で照らす）。
  // 図の束（/ui/graph.js）には頼らない（束が読めなくても、カードは同じ言葉を出す）
  var STATUS_CHIP = { run: 'running', wait: 'turn', stall: 'stall', fail: 'failed', done: 'finished', stopped: 'finished' };
  var STATUS_TEXT = { run: '動いている', wait: '● あなたの答え待ち', stall: '‖ 止まっているかも', fail: '✕ 失敗', done: '済んだ', stopped: '■ 止めた' };
  var RUN_TEXT = { pending: '起動を待っている', running: '動いている', waiting: '待っている', done: '済んだと報告（確かめ待ち）', stopping: '止めている', stopIncomplete: '■ 止まりきっていない' };
  var cardStatus = new Map();
  function statusesOf(view) {
    var waits = new Set();
    var stalls = new Set();
    var fails = new Set();
    view.decisions.forEach(function (d) { if (!d.closedReason) waits.add(d.nodeId); });
    view.extensions.forEach(function (x) { waits.add(x.nodeId); });
    view.inbox.forEach(function (i) {
      if (i.stall === true) stalls.add(i.nodeId);
      else if (i.priority === 'failed') fails.add(i.nodeId);
    });
    var m = new Map();
    view.nodes.forEach(function (n) {
      var st = n.band === 'finished' ? (n.state === 'stopped' ? 'stopped' : 'done') : fails.has(n.id) ? 'fail' : waits.has(n.id) ? 'wait' : stalls.has(n.id) ? 'stall' : 'run';
      // 言葉は、図と同じく、止まりきっていないを失敗の札にする前に決める（動いている扱いなら「■ 止まりきっていない」）
      var text = st === 'run' && Object.hasOwn(RUN_TEXT, n.state) ? RUN_TEXT[n.state] : STATUS_TEXT[st];
      if (n.state === 'stopIncomplete' && st === 'run') st = 'fail';
      m.set(n.id, { status: st, text: text });
    });
    return m;
  }
  // 時刻だけ（14:05）。読めなければ ''
  function clockText(iso) {
    var t = Date.parse(iso || '');
    if (!(t > 0)) return '';
    var d = new Date(t);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  // この 1 時間のやり取りの棒（5 分ずつ 12 区切り。藍はやり取り、柿は答え待ち）。高さは数の段（1〜4）
  var SPARK_SLOTS = 12;
  var SPARK_SLOT_MS = 5 * 60000;
  function sparkOf(id, flows, now) {
    var plain = [];
    var waits = [];
    for (var k = 0; k < SPARK_SLOTS; k += 1) { plain.push(0); waits.push(0); }
    flows.forEach(function (f) {
      if (f.from !== id && f.to !== id) return;
      var t = Date.parse(f.sentAt || '');
      if (!(t > 0) || t > now) return;
      var slot = SPARK_SLOTS - 1 - Math.floor((now - t) / SPARK_SLOT_MS);
      if (slot < 0) return;
      if (isAwaiting(f)) waits[slot] += 1;
      else plain[slot] += 1;
    });
    var box = el('div', 'spark');
    for (var j = 0; j < SPARK_SLOTS; j += 1) {
      var cell = el('div', 'slot');
      if (plain[j] > 0) cell.appendChild(el('span', 'bar l' + Math.min(4, plain[j])));
      // 答え待ちは、同じ数でも 2 段高くする（見本の高さ: 普通 19・答え待ち 29（34 の中）。あなたの出番を目立たせるため）
      if (waits[j] > 0) cell.appendChild(el('span', 'bar h l' + Math.min(4, waits[j] + 2)));
      box.appendChild(cell);
    }
    return box;
  }
  function latestFlowAt(id, flows) {
    var best = '';
    flows.forEach(function (f) { if ((f.from === id || f.to === id) && typeof f.sentAt === 'string' && f.sentAt > best) best = f.sentAt; });
    return best;
  }
  function nodeCard(n, byId, list, flows, delegated) {
    var band = n.band === 'turn' || n.band === 'finished' ? n.band : 'running';
    var st = cardStatus.get(n.id);
    var status = st ? st.status : band === 'finished' ? 'done' : 'run';
    var stall = status === 'stall';
    var card = el('div', 'card ' + band + (n.needsHuman > 0 ? ' need' : '') + (stall ? ' stall' : '') + pickedClass(n.id));
    if (ID_RE.test(n.id)) card.id = 'card-' + n.id;
    // 頭の札: 状態の札 1 つと、答えがあれば「あなたの答え N 件」
    var head = el('div', '');
    head.appendChild(el('span', 'chip ' + STATUS_CHIP[status], st ? cleanText(st.text, 40) : name(STATE_NAMES, n.state)));
    if (n.needsHuman > 0) head.appendChild(el('span', 'chip turn', 'あなたの答え ' + n.needsHuman + ' 件'));
    card.appendChild(head);
    card.appendChild(el('h3', '', nodeLabel(n, 200)));
    var meta = el('div', 'meta');
    var parent = n.parentId === null ? null : byId.get(n.parentId);
    meta.appendChild(el('span', '', name(ROLE_NAMES, n.role) + (n.parentId === null ? '（いちばん上）' : '（親：' + (parent ? nodeLabel(parent, 13) : n.parentId) + '）')));
    // 最後の動き。表示モデルに時刻がない（いちばん上の統合が、指示を出しただけ など）ときは、その子のいちばん新しいやり取りの時刻
    var last = n.lastActivityAt || latestFlowAt(n.id, flows);
    if (last) meta.appendChild(el('span', 'when', '最後の動き ' + timeText(last, Date.now())));
    card.appendChild(meta);
    card.appendChild(sparkOf(n.id, flows, Date.now()));
    // 最近のやり取り（新しい順に 3 件）
    var mine = flows.filter(function (f) { return f.from === n.id || f.to === n.id; }).slice(0, 3);
    if (mine.length) {
      var fl = el('div', 'flowlist');
      mine.forEach(function (f) { fl.appendChild(flowLine(f, n.id, byId)); });
      card.appendChild(fl);
    }
    // 止まっているかもしれない CLI の子は、開くコマンドを出す
    var cmd = stall ? attachCommand(n) : '';
    if (cmd) {
      var row = el('div', 'cmd');
      row.appendChild(el('code', '', cmd));
      row.appendChild(copyButton(cmd));
      card.appendChild(row);
    }
    // 受信箱の項目は、たたむ（新しい順）
    if (list.length) {
      var sorted = list.slice().sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
      var d = fold('inbox-' + n.id, (band === 'finished' ? '済んだ作業の知らせ ' : '知らせ ') + sorted.length + ' 件（たたんでいます）');
      sorted.forEach(function (i) { d.appendChild(entryRow(i, delegated)); });
      card.appendChild(d);
    }
    card.appendChild(nodeOps(n));
    return card;
  }
  // 答え待ちのやり取り（判断・範囲の頼みで、まだ済んでいないもの）だけ、柿色にする
  function isAwaiting(f) { return f.stage !== 'done' && (f.kind === 'decision' || f.kind === 'extension'); }
  // やり取りの短い本文が、この字数までなら 1 行に続けて出す（見本の flowlist）。長ければ、たたむ
  var FLOW_INLINE_MAX = 18;
  function flowLine(f, selfId, byId) {
    var up = f.dir === 'up';
    var other = f.from === selfId ? f.to : f.from;
    // 人とのやり取りは「あなた」（画面のほかの所の「あなたの答え」「あなたの出番」とそろえる）。相手の題は 10 字で切る（見本の short(題, 10)）
    var who = other === 'human' ? 'あなた' : byId.has(other) ? nodeLabel(byId.get(other), 11) : other;
    var line = el('div', 'fl');
    line.appendChild(el('span', 'ar ' + (isAwaiting(f) ? 'h' : up ? 'u' : 'd'), up ? '↑' : '↓'));
    var sum = (f.from === selfId ? '→ ' : '← ') + who + '　' + name(FLOW_KIND_NAMES, f.kind);
    var text = typeof f.text === 'string' ? cleanText(f.text, 400) : '';
    if (text && Array.from(text).length > FLOW_INLINE_MAX) {
      var d = el('details', 'fbody');
      d.appendChild(el('summary', '', sum));
      d.appendChild(el('p', '', text));
      line.appendChild(d);
    } else {
      line.appendChild(el('span', 'fbody', text ? sum + '：' + text : sum));
    }
    line.appendChild(el('span', 't', clockText(f.sentAt)));
    return line;
  }
  // 受信箱の知らせの文を、利用者の言葉にする（#115）。daemon の文にあるノード ID は子の題に、内部の言葉は言い換える。
  // ID は、カードの ID の欄で見られる。題のないノードは ID のまま
  var titleById = new Map();
  var DAEMON_SUMMARY_KINDS = { info: true, violation: true, stopIncomplete: true };
  var SUMMARY_WORDS = { command: 'コマンドを足す頼み', write: '書き込める場所を足す頼み' };
  function friendlySummary(text) {
    return text
      .replace(/[\\w:.-]+/g, function (w) {
        var t = titleById.get(w);
        return typeof t === 'string' && t !== '' ? '「' + cleanText(t, 40) + '」' : w;
      })
      .replace(/範囲の拡張要求(?:（(command|write)）)?/g, function (all, k) {
        return k ? SUMMARY_WORDS[k] : '範囲の頼み';
      });
  }
  function entryRow(i, delegated) {
    var band = inboxBand(i, delegated);
    var row = el('div', 'entry');
    markNew(row, 'e-' + i.id);
    var head = el('div', '');
    head.appendChild(el('span', 'chip ' + (i.stall === true ? 'stall' : band.cls), i.stall === true ? '止まっているかも' : isStopRequest(i, delegated) ? band.label : name(KIND_NAMES, i.kind)));
    head.appendChild(el('span', 'when', timeText(i.at, Date.now())));
    row.appendChild(head);
    var raw = typeof i.summary === 'string' ? i.summary : '';
    // 言い換えは、daemon が書く種類の知らせだけ（進み具合・完了・失敗・判断は、子が書いた文なので、そのまま出す）
    var text = Object.hasOwn(DAEMON_SUMMARY_KINDS, i.kind) ? friendlySummary(raw) : raw;
    if (Array.from(text).length > 60) {
      var d = fold('text-' + i.id, cleanText(text, 60));
      d.appendChild(el('div', 'confirm-line', text));
      row.appendChild(d);
    } else if (text) {
      row.appendChild(el('div', 'confirm-line', text));
    }
    return row;
  }
  // この子への操作（たたむ）。ボタンごとに、何をするか・取り消せるかを添える
  function nodeOps(n) {
    var box = el('div', 'opts');
    var any = false;
    // 停止したノードだけ、破棄の判断（回収の指示）ができる。指示済みなら、もう一度は出さない
    if (n.state === 'stopped') {
      if (n.discarded) { box.appendChild(el('span', 'tag', '破棄を指示済み（回収は統合ノードが行う）')); any = true; }
      else if (ID_RE.test(n.id)) {
        var reclaim = el('button', 'danger', '破棄して回収を指示…');
        reclaim.addEventListener('click', function () { startReclaim(n.id); });
        box.appendChild(reclaim);
        box.appendChild(el('p', 'irreversible', '取り消せません。止めた子の作業ツリーとブランチを消すよう、統合に指示します。'));
        any = true;
      }
    }
    // 停止を親に代行してもらうノード（stopDelegated。Desktop の子）が停止未完了なら、止めたと宣言できる
    if (n.state === 'stopIncomplete' && n.stopDelegated === true && ID_RE.test(n.id)) {
      box.appendChild(confirmStoppedBox(n.id));
      box.appendChild(el('p', 'irreversible', '取り消せません。親が Desktop でこの子を止めたと記録し、停止済みに進めます。'));
      any = true;
    }
    // 動いている子だけ、フックの結び付けを外せる。止まったノードにはフックが来ない。結び付けの有無は出さない（docs/ui.md）
    if (n.role !== 'integrator' && (n.state === 'running' || n.state === 'waiting') && ID_RE.test(n.id)) {
      box.appendChild(hookUnbindButton(n.id));
      box.appendChild(el('p', 'desc', '取り消せます。子のセッションを入れ直して、フックが拒まれ続けるときだけ使います。次に来たセッションに結び直します。'));
      any = true;
    }
    // ID と「写す」は、いつも、この中に出す（カードの表には出さない）
    var idl = el('div', 'idline', 'ID ' + n.id);
    if (ID_RE.test(n.id)) idl.appendChild(copyButton(n.id));
    var d = fold('ops-' + n.id, any ? 'この子への操作' : 'この子の ID');
    d.appendChild(idl);
    if (any) d.appendChild(box);
    return d;
  }

  // 一覧（木の字下げと、上り・下り）。描いたノードの数を返す（木にならない・深すぎるもので、描けなかった分は、呼び出し側が「一部省略」にする）。
  // 関係図（#89 の PR-5）は、#graph に描く。それまでは一覧だけ
  function lastFlow(flows, from, to) {
    for (var k = 0; k < flows.length; k += 1) if (flows[k].from === from && flows[k].to === to) return flows[k];
    return null;
  }
  // 上り（子 → 親）は、答えを待つ頼み（判断・範囲の頼みで、まだ済んでいないもの）があれば、新しい報告より先にそれ（図と同じ決め方）
  function upFlow(flows, from, to) {
    for (var k = 0; k < flows.length; k += 1) if (flows[k].from === from && flows[k].to === to && isAwaiting(flows[k])) return flows[k];
    return lastFlow(flows, from, to);
  }
  function flowCell(f, up, n) {
    if (!f) return el('span', 'when', n.parentId === null ? '（いちばん上）' : 'まだない');
    var c = el('span', isAwaiting(f) ? 'await' : up ? 'up' : 'down', (up ? '↑ ' : '↓ ') + name(FLOW_KIND_NAMES, f.kind) + '・' + stageText(f));
    c.appendChild(el('span', 'when', '　' + timeText(f.sentAt, Date.now())));
    return c;
  }
  // 関係図（#89）。/ui/graph.js が出す入口の draw・destroy だけを呼ぶ。読めないときは一覧だけ
  var graphMode = 'graph';
  var graphSeq = -1;
  var graphView = null;
  var graphDrawId = 0;
  function graphApi() {
    var g = window.touryouGraph;
    return g && typeof g.draw === 'function' && typeof g.destroy === 'function' ? g : null;
  }
  // いまの図の拡大・縮小の操作（graph.js の draw が返すもの。描けていなければ null）
  var graphCtl = null;
  function zoomGraph(how) {
    var c = graphCtl;
    if (!c) return;
    if (how === 'fit' && typeof c.fit === 'function') c.fit();
    else if (typeof c.zoomBy === 'function') c.zoomBy(how === 'in' ? 1.4 : 1 / 1.4);
  }
  function dropGraph() {
    graphCtl = null;
    var g = graphApi();
    if (g && graphSeq !== -1) g.destroy();
    graphSeq = -1;
    graphDrawId += 1; // 片付けたあとに、前の描きの失敗で一覧へ戻さない
  }
  function renderGraph(view, seq) {
    var g = graphApi();
    var on = !!g && graphMode === 'graph';
    document.getElementById('view-switch').hidden = !g;
    document.getElementById('graph').hidden = !on;
    document.getElementById('graph-legend').hidden = !on;
    document.getElementById('graph-zoom').hidden = !on;
    document.getElementById('list').hidden = on;
    document.getElementById('show-graph').ariaPressed = on ? 'true' : 'false';
    document.getElementById('show-list').ariaPressed = on ? 'false' : 'true';
    if (!on) { dropGraph(); return; }
    if (seq === graphSeq) return; // 変わっていなければ描き直さない（拡大・移動を保つ）
    graphSeq = seq;
    graphDrawId += 1;
    var mine = graphDrawId;
    // 描けなければ、一覧に戻す（図は飾り。一覧だけで読める）。戻すのは、いちばん新しい描きのときだけ
    var fallback = function () {
      if (mine !== graphDrawId) return;
      graphMode = 'list';
      dropGraph();
      renderGraph(view, seq);
    };
    var box = document.getElementById('graph');
    // 枠の高さを、描いた図の高さに合わせる（子が少ないときは縮める。拡大・移動は残る）
    var fit = function (r) {
      if (mine !== graphDrawId || !r || typeof r.height !== 'number' || !(r.height > 0)) return;
      graphCtl = r;
      box.style.height = Math.min(720, Math.max(180, Math.ceil(r.height))) + 'px';
    };
    try {
      // 箱を押したら、その子のカードへ移って光らせる（一覧の「詳しく」と同じ）。graph.js から返るのは ID だけ
      var pick = function (id) { if (typeof id === 'string' && ID_RE.test(id)) openCard(id); };
      Promise.resolve(g.draw(box, view, { onPick: pick })).then(fit, fallback);
    } catch (e) {
      fallback();
    }
  }
  function showGraphMode(mode) {
    graphMode = mode;
    if (graphView && lastView) { graphSeq = mode === 'graph' ? -1 : graphSeq; renderGraph(graphView, lastView.seq); }
  }
  function renderList(view) {
    var box = document.getElementById('list');
    clear(box);
    var nodes = view.nodes;
    if (!nodes.length) { box.appendChild(el('p', 'empty', '作業はまだありません')); return 0; }
    var head = el('div', 'trow thead');
    ['作業', '状態', '↑ 上り（子 → 親。答え待ちの頼みを先に）', '↓ 最後の下り（親・人 → 子）'].forEach(function (t) { head.appendChild(el('span', '', t)); });
    box.appendChild(head);
    var kids = new Map();
    nodes.forEach(function (n) {
      var k = n.parentId === null ? '' : n.parentId;
      if (!kids.has(k)) kids.set(k, []);
      kids.get(k).push(n);
    });
    var seen = new Set();
    function walk(parent, depth) {
      (kids.get(parent) || []).forEach(function (n) {
        if (seen.has(n.id) || depth > 64) return;
        seen.add(n.id);
        var band = n.band === 'turn' || n.band === 'finished' ? n.band : 'running';
        var row = el('div', 'trow ' + band);
        var t = el('span', 'tname');
        t.style.paddingLeft = (depth * 18) + 'px';
        if (depth) t.appendChild(el('span', 'when', '└'));
        t.appendChild(el('span', 'strong', nodeLabel(n, 28)));
        if (ID_RE.test(n.id)) {
          var go = el('button', 'sm quiet', '詳しく');
          go.addEventListener('click', function () { openCard(n.id); });
          t.appendChild(go);
        }
        row.appendChild(t);
        row.appendChild(el('span', 'chip ' + band, name(STATE_NAMES, n.state) + (n.needsHuman > 0 ? '・答え ' + n.needsHuman : '')));
        row.appendChild(flowCell(n.parentId === null ? null : upFlow(view.flows, n.id, n.parentId), true, n));
        row.appendChild(flowCell(n.parentId === null ? null : lastFlow(view.flows, n.parentId, n.id), false, n));
        box.appendChild(row);
        walk(n.id, depth + 1);
      });
    }
    walk('', 0);
    return seen.size;
  }
  // 一覧の「詳しく」: その子のカードまで動かして、光らせる（終わった作業なら、たたんだ欄を開く）
  // 移った先のカードを、1.5 秒、藍の縁で光らせる（どのカードに移ったか分かるように）。同じ子を続けて押したら、はじめから。
  // 光らせている途中にカードを作り直しても、残りの時間は縁を付けたままにする（子の ID と終わりの時刻を覚えておく）。
  // 動きを止める・OS の「視差効果を減らす」では、動きなしで縁の色だけを出す（CSS の animation:none）
  var PICK_MS = 1500;
  var pickId = '';
  var pickUntil = 0;
  var pickTimer = null;
  var pickFlip = false;
  function pickedClass(id) {
    return pickId === id && Date.now() < pickUntil ? ' picked' : '';
  }
  function openCard(id) {
    var c = document.getElementById('card-' + id);
    if (!c) return;
    if (c.parentNode && c.parentNode.id === 'finished-cards') document.getElementById('finished').open = true;
    c.scrollIntoView({ block: 'center' });
    pickId = id;
    pickUntil = Date.now() + PICK_MS;
    pickFlip = !pickFlip;
    // 動きのクラスを入れ替えて、続けて押したときも、はじめから動かす
    c.className = c.className.replace(/ picked( pa| pb)?/g, '') + ' picked ' + (pickFlip ? 'pa' : 'pb');
    if (pickTimer !== null) window.clearTimeout(pickTimer);
    pickTimer = window.setTimeout(function () {
      pickTimer = null;
      pickId = '';
      var now = document.getElementById('card-' + id);
      if (now) now.className = now.className.replace(/ picked( pa| pb)?/g, '');
    }, PICK_MS);
    // キーボード・読み上げのために、移った先へ focus も移す（ページは動かさない。上の scrollIntoView で見せてある）
    c.tabIndex = -1;
    c.focus({ preventScroll: true });
  }

  // ---- 回収の指示（人間による破棄の判断。取り消せない）----
  var EXPECT_TIPS_MAX = 256;
  var CLI_HINT = 'cli（touryou reclaim <ノード ID>）で、確かめてください。';
  var UNMET_NAMES = {
    stateNotEligible: '状態が、回収の対象でない', discardRequired: '破棄の判断が要る', factsMissing: '事実が足りない',
    notMerged: '統合されていない', dirty: '未保存の変更がある', dependentsIncomplete: '依存先が未完了', openDecision: '未回答の判断がある',
    descendantsNotReclaimable: '配下が回収できない', processesRunning: 'プロセスが動いている', processesUnknown: 'プロセスを調べられない'
  };
  // 事前確認（node.reclaimPreview）の結果の形。tips は、あれば、ノード ID から先端（文字列）への対応。
  function isReclaimPreview(v) {
    if (!v || typeof v !== 'object' || typeof v.reclaimable !== 'boolean' || !Array.isArray(v.unmet) || !Array.isArray(v.blockers)) return false;
    if (v.loss !== undefined && !Array.isArray(v.loss)) return false;
    if (v.tips !== undefined) {
      if (!v.tips || typeof v.tips !== 'object' || Array.isArray(v.tips)) return false;
      if (!Object.keys(v.tips).every(function (k) { return typeof v.tips[k] === 'string'; })) return false;
    }
    return true;
  }
  // 送れない理由（フェイルクローズ）。送れるなら ''。失われるものが分からないまま、取り消せない指示は出さない。
  function reclaimBlocked(v) {
    if (v.loss === undefined) return '失われるものの情報が得られませんでした（古い daemon です）。' + CLI_HINT;
    var unknown = v.loss.filter(function (l) { return l && (l.unknown === true || l.workingTreeUnknown === true); });
    if (unknown.length) {
      var ids = unknown.map(function (l) { return cleanText(String(l.nodeId), 128); }).join('、');
      return '失われるものを調べられなかったノードがあります（' + ids + '）。失われるものが分からないまま、破棄は指示できません。' + CLI_HINT;
    }
    var n = v.tips ? Object.keys(v.tips).length : 0;
    if (n > EXPECT_TIPS_MAX) return 'ノードが多すぎて、先端の照合ができません（' + n + ' 件。' + EXPECT_TIPS_MAX + ' 件まで）。' + CLI_HINT;
    return '';
  }
  function lossText(l) {
    var parts = [];
    parts.push(typeof l.aheadCommits === 'number' ? '統合されていないコミット ' + l.aheadCommits + ' 件' : '統合されていないコミットの数は不明');
    parts.push(l.uncommitted ? '追跡中のファイルの未保存の変更あり' : '未保存の変更なし');
    parts.push('未追跡のファイル ' + Number(l.untracked) + ' 件');
    return parts.join('。');
  }
  // 確認の表示（事前確認の結果）。パスは含まれない。件名は、信頼できない入力なので、整える。
  function reclaimLines(nodeId, v) {
    var lines = [
      ['対象', nodeId],
      ['内容', '破棄の判断は、取り消せません。停止したノードの作業ツリーとブランチが、強制して消えます。記録されるのは、この対象だけです（配下の停止ノードは、別に指示が必要です）']
    ];
    v.unmet.slice(0, 10).forEach(function (u) { lines.push(['満たしていない条件', name(UNMET_NAMES, String(u))]); });
    if (v.unmet.length > 10) lines.push(['満たしていない条件', 'ほか ' + (v.unmet.length - 10) + ' 件']);
    v.blockers.slice(0, 10).forEach(function (b) {
      var cmd = b && b.kind === 'process' && typeof b.command === 'string' ? cleanText(b.command, 33) : '';
      var who = b && b.kind === 'process' ? 'プロセス ' + Number(b.pid) + (cmd ? '（' + cmd + '）' : '') : 'ノード ' + cleanText(String(b && b.nodeId), 128);
      lines.push(['原因', who + '（' + name(UNMET_NAMES, String(b && b.reason)) + '）']);
    });
    if (v.blockers.length > 10) lines.push(['原因', 'ほか ' + (v.blockers.length - 10) + ' 件']);
    var loss = v.loss || [];
    var lossHead = '失われるもの（この対象と配下。配下は、それぞれの指示のときに失われる）';
    if (!loss.length) lines.push([lossHead, 'なし']);
    else lines.push([lossHead, loss.length + ' 件のノード']);
    loss.slice(0, NODE_LIST_MAX).forEach(function (l) {
      lines.push(['  ノード ' + cleanText(String(l.nodeId), 128), lossText(l)]);
      (Array.isArray(l.untrustedSubjects) ? l.untrustedSubjects : []).slice(0, 5).forEach(function (subject) {
        lines.push(['  コミットの件名（信頼できない入力）', cleanText(String(subject), 100)]);
      });
    });
    if (loss.length > NODE_LIST_MAX) lines.push(['  失われるもの', 'ほか ' + (loss.length - NODE_LIST_MAX) + ' 件（表示を省略。破棄の対象には、すべて含まれる）']);
    var tips = v.tips || {};
    var tipIds = Object.keys(tips).sort();
    tipIds.slice(0, NODE_LIST_MAX).forEach(function (k) {
      lines.push(['ブランチの先端（' + cleanText(k, 128) + '）', cleanText(tips[k].slice(0, 12), 12)]);
    });
    if (tipIds.length > NODE_LIST_MAX) lines.push(['ブランチの先端', 'ほか ' + (tipIds.length - NODE_LIST_MAX) + ' 件（すべて、照合に含める）']);
    lines.push(['照合', '見せた先端を、そのまま、指示に添えます。指示の時点で、先端が変わっていたら、何も記録されません']);
    return lines;
  }
  function startReclaim(nodeId) {
    readOperationResult('node.reclaimPreview', { nodeId: nodeId }).then(function (r) {
      if (r === null) return;
      if (!r.ok) { notice('失敗: ' + r.error.code + ': ' + r.error.cause, true); return; }
      var v = r.value;
      if (!isReclaimPreview(v)) { notice('事前確認の結果の形が不正です', true); return; }
      // 見せた先端（tips）を、作り直さずに、そのまま渡す。daemon が、今の先端と照合する（違えば tipMismatch）。
      var params = { nodeId: nodeId, expectTips: v.tips || {} };
      openConfirm('回収の指示（破棄）', reclaimLines(nodeId, v), 'node.reclaimInstruct', params, '破棄を指示しました（' + nodeId + '）。実際の回収は、統合ノードが行います', { typed: nodeId, blocked: reclaimBlocked(v) });
    });
  }

  // ---- 最終削除・保留・保管（取り消せない操作は、対象の ID を打ち込ませる）----
  var REASON_MAX = 200;
  var HOLD_CHOICES = [{ label: '無期限', days: 0 }, { label: '30 日', days: 30 }, { label: '90 日', days: 90 }];
  var HOLD_MAX_DAYS = 365;
  var NODE_LIST_MAX = 20;
  var EXPECT_NODE_IDS_MAX = 2000;
  var ID_RE = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/;
  var reasonDrafts = new Map();
  var noteDrafts = new Map();
  // ---- 停止の宣言（取り消せないので、対象のノード ID を打ち込ませる）----
  function checkNote(text) {
    if (text.trim() === '') return '';
    if (Array.from(text).length > REASON_MAX) return '根拠が長すぎます（' + REASON_MAX + ' 文字以下）';
    if (Array.from(text).some(function (ch) { return FORBIDDEN.test(ch); })) return '根拠に、使えない文字（制御文字・書式制御文字）が含まれています';
    return '';
  }
  // 見せたものを送る: 確認に出す根拠と、送る根拠は、同じ整えた値（前後の空白を削り、連続する空白を 1 つにする）
  function confirmStoppedParams(nodeId, note) {
    var shown = cleanText(note, REASON_MAX);
    return shown === '' ? { nodeId: nodeId } : { nodeId: nodeId, note: shown };
  }
  function confirmStoppedLines(nodeId, note) {
    return [
      ['ノード', nodeId],
      ['内容', '親が Desktop でこのノードのタスクを止めた（またはアーカイブした）と宣言し、停止未完了から停止済みに進める'],
      ['記録', '宣言した者（人間）と根拠を残し、受信箱の停止の代行依頼を解決済みにする'],
      ['根拠', cleanText(note, REASON_MAX) === '' ? '（なし）' : cleanText(note, REASON_MAX)]
    ];
  }
  function confirmStoppedBox(nodeId) {
    var box = el('div', 'opts');
    var area = field('stop-note');
    area.rows = 1;
    area.maxLength = REASON_MAX;
    area.placeholder = '止めた根拠（任意。' + REASON_MAX + ' 文字まで）';
    area.value = noteDrafts.get(nodeId) || '';
    area.addEventListener('input', function () { noteDrafts.set(nodeId, area.value); });
    var problem = el('p', 'error', '');
    problem.hidden = true;
    var b = el('button', '', '止めたと宣言…');
    b.addEventListener('click', function () {
      var why = checkNote(area.value);
      problem.textContent = why;
      problem.hidden = why === '';
      if (why !== '') return;
      var note = area.value;
      openConfirm('停止の宣言', confirmStoppedLines(nodeId, note), 'node.confirmStopped', confirmStoppedParams(nodeId, note), '止めたと宣言しました（' + nodeId + '）', { typed: nodeId, after: function () { noteDrafts.delete(nodeId); } });
    });
    box.appendChild(area);
    box.appendChild(b);
    box.appendChild(problem);
    return box;
  }
  // 回答の結果。再開しなかった子（notResumed）があれば、ID と理由を添える。理由は固定の文に写し、知らない記号・形の違う ID は出さない。10 件で切り「ほか N 件」
  var NOT_RESUMED_TEXT = {
    discarded: '破棄の判断を経たため',
    stoppedAfterStopIncomplete: '停止未完了のあと止め直したため。新しい子でやり直す',
    stoppedByOther: '判断のほかに止められたため'
  };
  function answerDoneText(value) {
    var list = value && Array.isArray(value.notResumed) ? value.notResumed : [];
    var parts = [];
    list.forEach(function (x) {
      if (!x || typeof x.nodeId !== 'string' || !ID_RE.test(x.nodeId)) return;
      var why = '理由は不明';
      if (x.reason === 'discarded' || x.reason === 'stoppedAfterStopIncomplete' || x.reason === 'stoppedByOther') why = NOT_RESUMED_TEXT[x.reason];
      parts.push(x.nodeId + '（' + why + '）');
    });
    if (parts.length === 0) return '回答を送りました';
    var more = parts.length > 10 ? '、ほか ' + (parts.length - 10) + ' 件' : '';
    return '回答を送りました。再開しなかった子: ' + parts.slice(0, 10).join('、') + more;
  }
  // フックの結び付けを外す。取り消せる操作（次に来たセッションに結び直すだけ）なので、打ち込みはない
  function hookUnbindLines(nodeId) {
    return [
      ['ノード', nodeId],
      ['内容', '（/clear・--resume で session_id が変わって、フックが拒否され続けるとき）フック（plugin のファイルで設定するフック）の session_id の結び付けを外す。次に来たセッションに結び直す'],
      ['記録', '外した者（人間）を残す'],
      ['注意', 'トークンが漏れた疑いがあるときは、外さずに、子を止めてトークンを失効させる']
    ];
  }
  function hookUnbindDoneText(nodeId, value) {
    if (value && value.duplicate === true) return 'すでに記録済みです（再送。もう一度は外していません）（' + nodeId + '）';
    if (value && value.unbound === true) return 'フックの結び付けを外しました（' + nodeId + '）。次に来たセッションに結び直します';
    return 'フックの結び付けはありませんでした（記録だけ残しました）（' + nodeId + '）';
  }
  function hookUnbindButton(nodeId) {
    var b = el('button', '', 'フックの結び付けを外す…');
    b.addEventListener('click', function () {
      openConfirm('フックの結び付けを外す', hookUnbindLines(nodeId), 'node.hookUnbind', { nodeId: nodeId }, function (value) { return hookUnbindDoneText(nodeId, value); });
    });
    return b;
  }
  var daysDrafts = new Map();
  var keptList = null;
  var purgeSignature = null;
  var keptLoading = false;
  // 最終削除の対象になりうる木の根: アーカイブ済みで、親がないか、親がアーカイブされていないノード。
  function purgeRoots(nodes) {
    var byId = new Map();
    nodes.forEach(function (n) { byId.set(n.id, n); });
    return nodes.filter(function (n) {
      if (n.state !== 'archived') return false;
      if (n.parentId === null) return true;
      var parent = byId.get(n.parentId);
      return !parent || parent.state !== 'archived';
    });
  }
  // 保留の成功の通知。daemon が決めた期限（結果の until）を出す。無期限なら、その旨。
  function holdDoneText(nodeId, value) {
    var until = value && typeof value.until === 'string' ? cleanText(value.until, 40) : '';
    return '保留しました（' + nodeId + '）。期限: ' + (until === '' ? '無期限' : until);
  }
  // 保留の params。日数は days で送り、期限は daemon の時計で決める（端末の時計は使わない）。days が 0 なら、無期限（days なし）。
  function holdParams(nodeId, days, reason) {
    var params = { nodeId: nodeId };
    if (days > 0) params.days = days;
    if (reason.trim() !== '') params.reason = reason;
    return params;
  }
  // 日数の入力（「その他」）: 1〜365 の整数だけ。不正なら 0。
  function parseDays(text) {
    var t = text.trim();
    if (!/^[0-9]{1,3}$/.test(t)) return 0;
    var n = Number(t);
    return n >= 1 && n <= HOLD_MAX_DAYS ? n : 0;
  }
  function checkDays(text) {
    return parseDays(text) === 0 ? '日数は、1〜' + HOLD_MAX_DAYS + ' の整数で指定してください' : '';
  }
  // 保留の理由の検査（任意。空は可）。問題がなければ ''。
  function checkReason(text) {
    if (text.trim() === '') return '';
    if (Array.from(text).length > REASON_MAX) return '理由が長すぎます（' + REASON_MAX + ' 文字以下）';
    if (Array.from(text).some(function (ch) { return FORBIDDEN.test(ch); })) return '理由に、使えない文字（制御文字・書式制御文字）が含まれています';
    return '';
  }
  // 信頼できない文字列（コミットの件名・タイトル）を、端末・画面に出す前に整える（制御文字・書式制御文字を空白に。1 行。長さを切る）。
  function cleanText(text, max) {
    var flat = Array.from(String(text)).map(function (ch) { return FORBIDDEN.test(ch) ? ' ' : ch; }).join('').replace(/\\s+/g, ' ').trim();
    var chars = Array.from(flat);
    return chars.length <= max ? flat : chars.slice(0, max - 1).join('') + '…';
  }
  function isPurgePreview(v) {
    return v && typeof v === 'object' && Array.isArray(v.nodeIds) && v.nodeIds.every(function (x) { return typeof x === 'string'; }) &&
      typeof v.archivedAt === 'string' && typeof v.elapsedDays === 'number' && typeof v.retentionDays === 'number' &&
      typeof v.tombstoneTitle === 'string' && typeof v.purgeable === 'boolean' && Array.isArray(v.blockers);
  }
  // 最終削除の確認の表示（事前確認の結果）。
  function purgeLines(rootId, v, tombstone) {
    var ids = v.nodeIds.slice(0, NODE_LIST_MAX).map(function (x) { return cleanText(x, 128); }).join('、');
    var more = v.nodeIds.length > NODE_LIST_MAX ? '、ほか ' + (v.nodeIds.length - NODE_LIST_MAX) + ' 件' : '';
    var lines = [
      ['木の根', rootId],
      ['削除されるノード', v.nodeIds.length + ' 件（' + ids + more + '）'],
      ['アーカイブ日', cleanText(v.archivedAt, 40) + '（経過 ' + v.elapsedDays + ' 日 / 保持期間 ' + v.retentionDays + ' 日）'],
      ['消した跡（題だけを残す記録）', (tombstone === false ? '残さない' : tombstone === true ? '残す' : '設定の既定に従う') + '（題: ' + cleanText(v.tombstoneTitle, 100) + '）']
    ];
    if (typeof v.discardedRefs === 'number' && v.discardedRefs > 0) lines.push(['一緒に消える保管', v.discardedRefs + ' 件の、破棄した成果（取り出すなら、先に保管の一覧から）']);
    if (v.hold && typeof v.hold === 'object') lines.push(['保留', '保留中（ノード ' + cleanText(String(v.hold.nodeId || ''), 128) + (v.hold.until ? '。' + cleanText(String(v.hold.until), 40) + ' まで' : '。無期限') + '）。保留は自動の削除だけを止める。この最終削除は、保留を無視して消す']);
    v.blockers.slice(0, 10).forEach(function (b) {
      lines.push(['実行できない理由', cleanText(String(b && b.code), 60) + ': ' + cleanText(String(b && b.cause), 300)]);
    });
    return lines;
  }
  // 今の保留の状態（事前確認の hold）。取れなければ、取れなかったと出す（なし、とは言わない）。
  function holdStatusLine(rootId) {
    return readOperationResult('node.purgePreview', { nodeId: rootId }).then(function (r) {
      if (r === null || !r.ok) return '（取得できなかった）';
      var h = r.value && r.value.hold;
      if (!h || typeof h !== 'object') return 'なし';
      var until = typeof h.until === 'string' ? cleanText(h.until, 40) + ' まで' : '無期限';
      var reason = typeof h.reason === 'string' && h.reason !== '' ? '。理由: ' + cleanText(h.reason, 200) : '';
      return '保留中（ノード ' + cleanText(String(h.nodeId || ''), 128) + '。' + until + reason + '）';
    });
  }
  function startPurge(rootId, tombstone) {
    readOperation('node.purgePreview', { nodeId: rootId }).then(function (v) {
      if (v === null) return;
      if (!isPurgePreview(v)) { notice('事前確認の結果の形が不正です', true); return; }
      // 見せた木（削除されるノード）を渡す。見せたあとで木が変わっていたら、daemon が消さない（purgeStale）。
      var params = tombstone === undefined ? { nodeId: rootId } : { nodeId: rootId, tombstone: tombstone };
      params.expectNodeIds = v.nodeIds;
      var blocked = v.purgeable ? '' : 'この木は、いま最終削除できません（上の理由を取り除いてから、もう一度確認してください）';
      if (v.nodeIds.length > EXPECT_NODE_IDS_MAX) blocked = '木のノードが多すぎて、安全に確認できません（' + v.nodeIds.length + ' 件。' + EXPECT_NODE_IDS_MAX + ' 件まで）';
      openConfirm('最終削除', purgeLines(rootId, v, tombstone), 'node.purge', params, '最終削除しました（' + rootId + '）', { typed: rootId, blocked: blocked });
    });
  }
  function renderPurge(nodes) {
    var roots = purgeRoots(nodes).map(function (n) { return n.id; });
    var signature = roots.join('\\n');
    if (signature === purgeSignature) return; // 根の集合が変わらなければ、描き直さない（入力中の理由を消さない）
    purgeSignature = signature;
    reasonDrafts.forEach(function (_v, key) { if (roots.indexOf(key) < 0) reasonDrafts.delete(key); });
    daysDrafts.forEach(function (_v, key) { if (roots.indexOf(key) < 0) daysDrafts.delete(key); });
    var box = document.getElementById('purge');
    clear(box);
    if (!roots.length) { box.appendChild(el('p', 'empty', '最終削除の対象になりうる、アーカイブ済みの木はありません')); return; }
    roots.forEach(function (id) {
      var card = el('div', 'card');
      card.appendChild(el('span', 'tag', 'アーカイブ済みの木'));
      card.appendChild(el('span', '', id));
      var del = el('div', 'opts');
      var b1 = el('button', '', '最終削除…（消した跡は設定の既定）');
      b1.addEventListener('click', function () { startPurge(id, undefined); });
      var b2 = el('button', '', '消した跡も残さずに最終削除…');
      b2.addEventListener('click', function () { startPurge(id, false); });
      del.appendChild(b1);
      del.appendChild(b2);
      card.appendChild(del);
      var area = field('hold-reason');
      area.maxLength = REASON_MAX;
      area.placeholder = '自動の最終削除を保留する理由（任意。' + REASON_MAX + ' 文字まで）';
      area.value = reasonDrafts.get(id) || '';
      area.addEventListener('input', function () { reasonDrafts.set(id, area.value); });
      card.appendChild(area);
      var problem = el('p', 'error', '');
      problem.hidden = true;
      var hold = el('div', 'opts');
      // 保留の確認を出す（理由の検査のあと、今の保留を取って、確認に出す）。days が 0 なら無期限。
      var askHold = function (label, days) {
        var why = checkReason(area.value);
        problem.textContent = why;
        problem.hidden = why === '';
        if (why !== '') return;
        var params = holdParams(id, days, area.value);
        var reason = area.value;
        holdStatusLine(id).then(function (current) {
          openConfirm('自動の最終削除の保留', [['木の根', id], ['今の保留', current], ['新しい期限', days > 0 ? '保留した時点から ' + label + ' 後（期限は、daemon の時計で決める。実際の期限は、保留した直後の通知に出る）。今の保留は、置き換わる' : '無期限。今の保留は、置き換わる'], ['理由', reason.trim() === '' ? '（なし）' : reason]], 'node.purgeHold', params, function (value) { return holdDoneText(id, value); });
        });
      };
      HOLD_CHOICES.forEach(function (c) {
        var b = el('button', '', '自動削除を保留（' + c.label + '）…');
        b.addEventListener('click', function () { askHold(c.label, c.days); });
        hold.appendChild(b);
      });
      var daysArea = field('hold-days');
      daysArea.rows = 1;
      daysArea.maxLength = 3;
      daysArea.inputMode = 'numeric';
      daysArea.placeholder = '日数（1〜' + HOLD_MAX_DAYS + '）';
      daysArea.value = daysDrafts.get(id) || '';
      daysArea.addEventListener('input', function () { daysDrafts.set(id, daysArea.value); });
      var custom = el('button', '', '指定した日数で保留…');
      custom.addEventListener('click', function () {
        var bad = checkDays(daysArea.value);
        if (bad !== '') { problem.textContent = bad; problem.hidden = false; return; }
        var n = parseDays(daysArea.value);
        askHold(n + ' 日', n);
      });
      hold.appendChild(daysArea);
      hold.appendChild(custom);
      var rel = el('button', '', '保留を解除…');
      rel.addEventListener('click', function () {
        holdStatusLine(id).then(function (current) {
          openConfirm('保留の解除', [['木の根', id], ['今の保留', current], ['内容', '保留を解除する（解除後は、保持期間と予告の条件を、改めて満たすまで消えない）']], 'node.purgeRelease', { nodeId: id }, '保留を解除しました（' + id + '）');
        });
      });
      hold.appendChild(rel);
      card.appendChild(hold);
      card.appendChild(problem);
      box.appendChild(card);
    });
  }
  function loadKept() {
    if (keptLoading) return;
    keptLoading = true;
    readOperation('node.discardedList', {}).then(function (v) {
      keptLoading = false;
      if (v === null) return;
      if (!v || !Array.isArray(v.items) || typeof v.max !== 'number') { notice('保管の一覧の形が不正です', true); return; }
      keptList = v;
      renderKept();
    });
  }
  function renderKept() {
    var box = document.getElementById('kept');
    clear(box);
    var load = el('button', '', keptList ? '一覧を読み込み直す' : '一覧を読み込む');
    load.addEventListener('click', loadKept);
    box.appendChild(load);
    if (!keptList) return;
    box.appendChild(el('p', 'empty', '保管: ' + keptList.items.length + ' 件 / 上限 ' + keptList.max + ' 件（自動では更新しません。取り出す・消すのあとは、読み込み直します）'));
    keptList.items.forEach(function (i) {
      if (typeof i.key !== 'string' || typeof i.tip !== 'string') return;
      var keyOk = ID_RE.test(i.key); // ID の形でない key には、操作を出さない（daemon も、ID の形でない target を拒む）
      var card = el('div', 'card');
      card.appendChild(el('span', 'tag', cleanText(i.key, 128)));
      card.appendChild(el('span', 'tag', i.nodeId ? 'ノード ' + cleanText(i.nodeId, 128) : '孤立'));
      card.appendChild(el('span', 'tag', '先端 ' + cleanText(i.tip.slice(0, 12), 12)));
      if (i.committedAt) card.appendChild(el('span', 'tag', cleanText(i.committedAt, 40)));
      if (i.untrustedSubject) card.appendChild(el('div', '', '件名（信頼できない入力）: 「' + cleanText(i.untrustedSubject, 100) + '」'));
      var opts = el('div', 'opts');
      var restore = el('button', '', 'ブランチに取り出す…');
      restore.addEventListener('click', function () {
        openConfirm('保管の取り出し', [['保管', cleanText(i.key, 128)], ['先端', cleanText(i.tip.slice(0, 12), 12)], ['内容', '新しいブランチ（touryou/restored/<保管の名前>）を作る。既存のブランチは上書きしない。保管は残る']], 'node.discardedRestore', { target: i.key }, 'ブランチを作りました', { after: loadKept });
      });
      var drop = el('button', '', '保管を消す…');
      drop.addEventListener('click', function () {
        openConfirm('保管の削除', [['保管', cleanText(i.key, 128)], ['ノード', i.nodeId ? cleanText(i.nodeId, 128) : '孤立'], ['先端', cleanText(i.tip.slice(0, 12), 12) + '（一覧で見た先端と今の先端が違えば、消さない）']], 'node.discardedDrop', { target: i.key, expectTip: i.tip }, '保管を消しました', { typed: i.key, after: loadKept });
      });
      if (keyOk) {
        opts.appendChild(restore);
        opts.appendChild(drop);
        card.appendChild(opts);
      } else {
        card.appendChild(el('p', 'error', 'この保管の名前は、ID の形でないため、画面からは操作できません（touryou discarded で操作してください）'));
      }
      box.appendChild(card);
    });
  }

  // ---- 取り消せない操作の確認待ち（Desktop の木）。ページのいちばん上に固定して出す（スクロールしなくても見える）----
  var CONFIRM_OP_LABELS = { 'node.purge': '最終削除', 'node.discardedDrop': '保管の削除', 'node.reclaimInstruct': '破棄して回収の指示' };
  var codeDrafts = new Map();
  var approvalErrors = new Map();
  var approvalSending = new Set();
  var shownApprovals = '';
  // 確認待ちの 1 件の説明の行（textContent で描く）。
  function approvalLines(c) {
    return [
      ['操作', name(CONFIRM_OP_LABELS, c.operation) + '（' + c.operation + '）'],
      ['対象', c.target],
      ['確認の番号', c.shortId + '…（端末の行の「確認 ' + c.shortId + '…」と同じか、見比べる）'],
      ['期限', c.expiresAt + '（残り ' + c.attemptsLeft + ' 回まで打てる）']
    ];
  }
  function approve(c, code) {
    if (approvalSending.has(c.confirmationId)) return;
    if (!window.crypto || !window.crypto.randomUUID) { notice('このブラウザでは、操作できません（crypto.randomUUID がありません）', true); return; }
    approvalSending.add(c.confirmationId);
    approvalErrors.delete(c.confirmationId);
    callOperation('confirm.approve', { confirmationId: c.confirmationId, code: code }, window.crypto.randomUUID())
      .then(function (r) {
        approvalSending.delete(c.confirmationId);
        if (r === null) return;
        if (r.status === 200 && r.body && r.body.ok === true) {
          codeDrafts.delete(c.confirmationId);
          notice('確認して実行しました（' + name(CONFIRM_OP_LABELS, c.operation) + '）');
        } else {
          // 失敗のあと、確認待ちが消えている（5 回目の誤り・期限切れ・実行のあとの失敗）と、欄の中の理由は描かれないので、
          // ページ全体の通知（赤）にも出す
          var why = describeFailure(r);
          approvalErrors.set(c.confirmationId, why);
          notice('確認できませんでした（' + name(CONFIRM_OP_LABELS, c.operation) + '）: ' + why, true);
        }
        refresh();
      })
      .catch(function () {
        approvalSending.delete(c.confirmationId);
        approvalErrors.set(c.confirmationId, '送れませんでした（daemon に接続できません）');
        notice('確認を送れませんでした（daemon に接続できません）', true);
        refresh();
      });
  }
  function cancelApproval(c) {
    if (!window.crypto || !window.crypto.randomUUID) return;
    callOperation('confirm.cancel', { confirmationId: c.confirmationId }, window.crypto.randomUUID())
      .then(function () { codeDrafts.delete(c.confirmationId); refresh(); })
      .catch(function () { refresh(); });
  }
  function renderApprovals(list) {
    var box = document.getElementById('approvals');
    var items = Array.isArray(list) ? list.filter(function (c) { return c && typeof c.confirmationId === 'string' && ID_RE.test(c.confirmationId); }) : [];
    var active = document.activeElement;
    var focused = active && box.contains(active) ? active.dataset.approval : '';
    // 人がほかの入力欄で打っている最中は、確認の欄へフォーカスを移さず、スクロールもしない（入力を奪わない）
    var typingElsewhere = !!active && !box.contains(active) && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT');
    clear(box);
    if (items.length === 0) { box.hidden = true; shownApprovals = ''; return; }
    box.hidden = false;
    box.appendChild(el('div', 'confirm-title', '確認待ち（取り消せない操作。まだ実行していません）'));
    box.appendChild(el('p', '', 'daemon を起動した端末に出たコードを打つと、実行します。端末の行の確認の番号と、ここの番号が同じか見比べてください。心当たりがなければ「取り消す」を押してください。'));
    var first = null;
    var keep = null;
    items.forEach(function (c) {
      var card = el('div', 'card');
      approvalLines(c).forEach(function (line) {
        var row = el('div', 'confirm-line');
        row.appendChild(el('span', 'tag', line[0]));
        row.appendChild(el('span', '', line[1]));
        card.appendChild(row);
      });
      var area = field('approval-code');
      area.maxLength = 16;
      area.rows = 1;
      area.spellcheck = false;
      area.autocomplete = 'off';
      area.ariaLabel = '確認コード';
      area.dataset.approval = c.confirmationId;
      area.value = codeDrafts.get(c.confirmationId) || '';
      area.addEventListener('input', function () { codeDrafts.set(c.confirmationId, area.value); });
      area.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); approve(c, area.value); } });
      card.appendChild(area);
      var go = el('button', '', approvalSending.has(c.confirmationId) ? '送っています…' : '確認して実行する');
      go.disabled = approvalSending.has(c.confirmationId);
      go.addEventListener('click', function () { approve(c, area.value); });
      card.appendChild(go);
      var stop = el('button', '', '取り消す');
      stop.addEventListener('click', function () { cancelApproval(c); });
      card.appendChild(stop);
      var why = approvalErrors.get(c.confirmationId);
      if (why) card.appendChild(el('p', 'error', why));
      box.appendChild(card);
      if (first === null) first = area;
      if (focused === c.confirmationId) keep = area;
    });
    var ids = items.map(function (c) { return c.confirmationId; }).join(',');
    var target = keep || (ids !== shownApprovals && !typingElsewhere ? first : null);
    shownApprovals = ids;
    if (target) {
      target.focus();
      target.setSelectionRange(target.value.length, target.value.length);
      if (!keep) box.scrollIntoView({ block: 'start' });
    }
    var live = new Set(items.map(function (c) { return c.confirmationId; }));
    codeDrafts.forEach(function (_v, id) { if (!live.has(id)) codeDrafts.delete(id); });
    approvalErrors.forEach(function (_v, id) { if (!live.has(id)) approvalErrors.delete(id); });
  }

  function render(view) {
    renderApprovals(view.confirmations);
    var flows = Array.isArray(view.flows) ? view.flows : [];
    var v = { nodes: view.nodes, inbox: view.inbox, decisions: view.decisions, extensions: view.extensions, flows: flows };
    var byId = new Map();
    view.nodes.forEach(function (n) { byId.set(n.id, n); });
    titleById = new Map();
    view.nodes.forEach(function (n) { if (typeof n.title === 'string') titleById.set(n.id, n.title); });
    nextSeen = new Set();
    renderTodo(v, byId);
    cardStatus = statusesOf(v);
    // カードは描き直しのたびに作り直すので、focus がカードにあったら、作り直したあとの同じ子のカードへ戻す
    // （移った先を、キーボード・読み上げの人が見失わないように）。入力欄など、ほかに focus があるときは触らない
    var act = document.activeElement;
    var focusedCard = act && typeof act.id === 'string' && /^card-/.test(act.id) ? act.id : '';
    renderCards(v, byId);
    if (focusedCard) {
      var again = document.getElementById(focusedCard);
      if (again) { again.tabIndex = -1; again.focus({ preventScroll: true }); }
    }
    var drawn = renderList(v);
    graphView = v;
    renderGraph(v, view.lastSeq);
    seenItems = nextSeen;
    renderPurge(view.nodes);
    showAuth(false);
    var partial = view.truncated.length > 0 || drawn < view.nodes.length;
    lastView = { seq: view.lastSeq, partial: partial };
    showConnected();
  }

  var etag = '';

  function showConnected() {
    if (!lastView) return;
    var how = sseUp ? '変わるとすぐ更新'
      : document.hidden ? (HIDDEN_POLL_MS / 1000) + ' 秒ごとに確かめて更新'
      : (POLL_MS / 1000) + ' 秒ごとに確かめて更新';
    if (!sseUp && sseState === 'replaced') how = '別のタブで開いています。' + how + '。このタブを選ぶと、すぐ更新に戻ります';
    setStatus('つながっています（' + how + (lastView.partial ? '。数が多いので一部を省いています' : '') + '）');
    statusEl.className = 'status live';
  }
  function rejectToken(message) {
    if (viaSession) {
      viaSession = false;
      message = '画面のセッションが切れました（使わずに 1 時間たった・開いてから 12 時間たった・daemon を起動し直した など）。/touryou:ui（または Mac のターミナルで touryou ui）で開き直してください';
    }
    dropGraph(); graphView = null;
    token = ''; etag = ''; lastView = null; generation += 1; sseUp = false; keptList = null; purgeSignature = null; pending = null;
    if (controller) controller.abort();
    document.getElementById('approvals').hidden = true; codeDrafts.clear(); approvalErrors.clear();
    showAuth(true); setStatus(message);
  }

  // 取得できないときの表示。理由と、確かめることを言う（自動で再試行は続ける）。
  var UNREACHABLE_TEXT = 'daemon に接続できません（daemon が止まっている・再起動してポートが変わった・ネットワークの失敗）。daemon が動いているか、このページの URL のポートが今の daemon と同じかを確かめてください。再試行します';
  function fetchFailureText(status) {
    if (status === 429) return '取得に失敗（429: 要求が多すぎます）。しばらく待ってから、再試行します';
    if (status >= 500) return '取得に失敗（' + status + ': daemon の内部の失敗）。daemon のログを確かめてください。再試行します';
    return '取得に失敗（' + status + '）。再試行します';
  }
  function fetchState() {
    var headers = etag
      ? { authorization: 'Bearer ' + token, 'if-none-match': etag }
      : { authorization: 'Bearer ' + token };
    return fetch('/v1/ui/state', { headers: headers })
      .then(function (res) {
        if (res.status === 304) { return { unchanged: true }; }
        if (res.status === 401) { rejectToken('トークンが正しくありません'); return null; }
        if (res.status === 403) { rejectToken('人間のトークンが必要です'); return null; }
        if (!res.ok) { setStatus(fetchFailureText(res.status)); return null; }
        etag = res.headers.get('etag') || '';
        return res.json();
      })
      .then(function (body) {
        if (body && body.ok) render(body.value);
      })
      .catch(function () { setStatus(UNREACHABLE_TEXT); });
  }

  // 同時に 1 回だけ取る。取っている間に通知が来たら、終わってからもう 1 回取る。
  function refresh() {
    if (!token) { showAuth(true); setStatus('未接続'); return Promise.resolve(); }
    if (refreshing) { again = true; return Promise.resolve(); }
    refreshing = true;
    lastRefreshAt = Date.now();
    return fetchState().then(function () {
      refreshing = false;
      if (again) { again = false; return refresh(); }
    });
  }

  // 通知が続いても、状態を取り直すのは、最短 THROTTLE_MS ごと（先頭で 1 回、間に来たものは末尾で 1 回）。
  function requestRefresh() {
    if (throttleTimer !== null) return;
    var wait = THROTTLE_MS - (Date.now() - lastRefreshAt);
    if (wait <= 0) { refresh(); return; }
    throttleTimer = window.setTimeout(function () { throttleTimer = null; refresh(); }, wait);
  }

  // SSE（変更の通知）。fetch の ReadableStream で読む（EventSource は header を付けられない）。切れたら、指数バックオフで再接続する。
  // 使えない間（接続できない・未対応）は、下の loop が、ETag つきのポーリングで取る。
  function connectEvents(gen) {
    if (!token || gen !== generation) return;
    if (typeof TextDecoder === 'undefined') return;
    reconnectTimer = null;
    sseState = 'connecting';
    controller = new AbortController();
    fetch('/v1/events', { headers: { authorization: 'Bearer ' + token }, signal: controller.signal })
      .then(function (res) {
        if (res.status === 401) { rejectToken('トークンが正しくありません'); return null; }
        if (res.status === 403) { rejectToken('人間のトークンが必要です'); return null; }
        if (res.status === 429) {
          var seconds = parseInt(res.headers.get('retry-after') || '', 10);
          retryMs = seconds > 0 ? Math.min(seconds, 300) * 1000 : 0;
          tooManyCount += 1;
          if (tooManyCount >= TOO_MANY_MAX) sseState = 'gaveUp';
        }
        if (!res.ok || !res.body || !res.body.getReader) throw new Error('sse');
        tooManyCount = 0;
        sseState = 'live';
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buf = '';
        sseUp = true;
        backoff = BACKOFF_MIN;
        showConnected();
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) throw new Error('closed');
            buf += decoder.decode(r.value, { stream: true });
            var end = buf.indexOf('\\n\\n');
            while (end >= 0) {
              var block = buf.slice(0, end);
              buf = buf.slice(end + 2);
              if (block.indexOf('event: replaced') >= 0) {
                // ほかのタブに枠を譲った（daemon が閉じる）。張り直さずにポーリングに移る（見えたとき・フォーカスで張り直す）
                sseState = 'replaced';
                throw new Error('replaced');
              }
              if (block.indexOf('event: seq') >= 0) requestRefresh();
              end = buf.indexOf('\\n\\n');
            }
            if (buf.length > 4096) buf = '';
            return pump();
          });
        }
        return pump();
      })
      .catch(function () {})
      .then(function () {
        sseUp = false;
        showConnected();
        if (gen !== generation || !token) return;
        if (sseState === 'paused' || sseState === 'replaced' || sseState === 'gaveUp') return;
        sseState = 'retrying';
        // 429 のときは、Retry-After の秒数より前には、再接続しない
        var wait = Math.max(backoff, retryMs) + Math.floor(Math.random() * 500);
        retryMs = 0;
        backoff = Math.min(backoff * 2, BACKOFF_MAX);
        reconnectTimer = window.setTimeout(function () { connectEvents(gen); }, wait);
      });
  }

  // SSE が上がっている間は、安全のために、まれに取り直す。上がっていない間は、POLL_MS ごと（ETag で、変化がなければ 304）。
  function loop(gen) {
    if (gen !== generation) return;
    var due = !sseUp || Date.now() - lastRefreshAt >= SAFETY_MS;
    // 裏のタブは、確かめの間を空ける
    var every = document.hidden ? HIDDEN_POLL_MS : POLL_MS;
    (due ? refresh() : Promise.resolve()).then(function () { timer = window.setTimeout(function () { loop(gen); }, every); });
  }

  // 裏に回って HIDE_CLOSE_MS（4 秒）たったら、購読を閉じる（ほかのタブに枠を空ける）。張り直しの待ちも取り消す
  function pauseEvents() {
    hideTimer = null;
    if (!token || !document.hidden) return;
    if (reconnectTimer !== null) { window.clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (sseState === 'replaced' || sseState === 'gaveUp') return;
    sseState = 'paused';
    if (controller) controller.abort();
  }
  // 見えたとき・フォーカスが来たとき: 自分から止めていた購読（裏・譲った・429 が続いた）だけを張り直し、すぐ 1 回取り直す。
  // つながっている・張り直しを待っている間は何もしない（タブどうしで、自分から交互に追い出し合わない）
  function resumeEvents() {
    if (!token || document.hidden) return;
    if (sseState !== 'paused' && sseState !== 'replaced' && sseState !== 'gaveUp') return;
    tooManyCount = 0;
    backoff = BACKOFF_MIN;
    requestRefresh();
    connectEvents(generation);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (hideTimer === null) hideTimer = window.setTimeout(pauseEvents, HIDE_CLOSE_MS);
      return;
    }
    if (hideTimer !== null) { window.clearTimeout(hideTimer); hideTimer = null; }
    resumeEvents();
  });
  window.addEventListener('focus', resumeEvents);

  function start() {
    generation += 1;
    if (controller) controller.abort();
    sseUp = false;
    backoff = BACKOFF_MIN;
    sseState = 'idle';
    tooManyCount = 0;
    if (reconnectTimer !== null) { window.clearTimeout(reconnectTimer); reconnectTimer = null; }
    // 前の裏の待ちが、新しい購読を閉じないように（今が裏なら、新しく数え直す）
    if (hideTimer !== null) { window.clearTimeout(hideTimer); hideTimer = null; }
    if (document.hidden) hideTimer = window.setTimeout(pauseEvents, HIDE_CLOSE_MS);
    if (timer !== null) window.clearTimeout(timer);
    var gen = generation;
    // 取れなかった（トークンが拒まれた）ときは、世代が進むので、接続も周期も始めない（表示を上書きしない）。
    refresh().then(function () { connectEvents(gen); loop(gen); });
  }

  document.getElementById('auth-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var input = document.getElementById('token');
    token = input.value.trim();
    viaSession = false;
    input.value = '';
    start();
  });

  // チケットを、画面のセッションのトークンに交換する。失敗の理由は分けない（誤り・期限切れ・使用済みは同じ）。
  function exchangeTicket(t) {
    setStatus('接続しています');
    return fetch('/v1/ui/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: t }),
    })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (body) {
        if (body && body.ok && body.value && typeof body.value.session === 'string') { token = body.value.session; viaSession = true; }
      })
      .catch(function () {});
  }

  // 動きを止める（OS の「視差効果を減らす」でも止まる。CSS の prefers-reduced-motion）
  document.getElementById('show-graph').addEventListener('click', function () { showGraphMode('graph'); });
  document.getElementById('zoom-in').addEventListener('click', function () { zoomGraph('in'); });
  document.getElementById('zoom-out').addEventListener('click', function () { zoomGraph('out'); });
  document.getElementById('zoom-fit').addEventListener('click', function () { zoomGraph('fit'); });
  document.getElementById('show-list').addEventListener('click', function () { showGraphMode('list'); });
  var stillBtn = document.getElementById('still');
  stillBtn.addEventListener('click', function () {
    var on = document.documentElement.classList.toggle('still');
    stillBtn.textContent = on ? '動きを戻す' : '動きを止める';
  });

  renderKept();
  if (ticket) {
    var t0 = ticket;
    ticket = '';
    exchangeTicket(t0).then(function () {
      if (token) start();
      else rejectToken('画面を開けませんでした（チケットが使えない）。Mac のターミナルで touryou ui を実行して、開き直してください');
    });
  } else {
    start();
  }
})();
`;

/** 画面の応答ヘッダー（CSP など）。インラインを許さず、同じ origin の資産と通信だけを許す。 */
export const UI_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "cross-origin-resource-policy": "same-origin",
};

/** HTML だけに付けるヘッダー（ほかのオリジンのページと、ウィンドウを共有しない。使わない機能を許さない）。 */
export const UI_HTML_HEADERS: Readonly<Record<string, string>> = {
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), interest-cohort=()",
};
