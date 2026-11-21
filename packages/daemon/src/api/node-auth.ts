/**
 * ノードの資格情報（トークン）の確かめ。`POST /v1/request` と同じ手順（Bearer → `authenticate` → `checkPrincipal`）を、
 * 窓口の外からも呼べるように出したもの。`/v1/events`（C）など、別の入口が同じ確かめを使う。
 *
 * - CLI の子のトークンは、紐付け（`POST /v1/bind`）でだけ発行される。根の統合セッションは、根のトークンのまま。
 * - 失敗の理由は区別しない（`undefined`）。トークンは、記録・失敗の文に出さない。
 */

import type { OrchState } from "@touryou/core";
import { checkPrincipal } from "./authorize.js";
import { type CredentialStore, type Principal, parseBearer } from "./credentials.js";

export interface NodeAuthDeps {
  readonly credentials: Pick<CredentialStore, "authenticate">;
  readonly getState: () => OrchState;
}

/**
 * `Authorization` のヘッダの値から、主体を確かめる。トークンが無効・ノードの状態が許さないときは `undefined`。
 * `touch` を偽にすると、使ったものとして数えない（使わなければ切れる時計を延ばさない。購読の接続・heartbeat の確かめ用）。
 */
export function verifyNodeToken(
  deps: NodeAuthDeps,
  authorization: unknown,
  touch = true,
): Principal | undefined {
  const principal = deps.credentials.authenticate(parseBearer(authorization), touch);
  if (principal === undefined) return undefined;
  return checkPrincipal(principal, deps.getState()).ok ? principal : undefined;
}
