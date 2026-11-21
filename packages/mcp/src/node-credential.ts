/**
 * 子ごとの資格情報の入れ物（紐付けと購読で共有する）。mcp のプロセスの中だけに持つ（ファイル・環境変数・ログに出さない）。
 *
 * - 紐付けの道具（`child_bind`）が成功したら `set`。失効（daemon の 401）が分かったら `clear` で空にする。
 * - `onChange`: 値が変わるたびに呼ぶ（`/v1/events` の購読は、値が入ったら始め、空になったら止める）。外す関数を返す。
 * - 根の統合セッション（紐付けを使わない）は、この入れ物を使わない（根のトークンのまま）。
 */

export interface NodeCredential {
  readonly nodeId: string;
  readonly token: string;
}

export interface NodeCredentialStore {
  get(): NodeCredential | undefined;
  set(c: NodeCredential): void;
  clear(): void;
  onChange(fn: (c: NodeCredential | undefined) => void): () => void;
  /**
   * daemon が、この token を拒んだ（401 `unauthenticated`）。復旧（`setRecover`）が通れば、入れ物は新しい資格情報に替わり、
   * 真を返す。通らなければ、入れ物を空にして偽を返す。すでに別の資格情報に替わっていれば、何もせず真を返す。
   */
  reject(token: string): Promise<boolean>;
  /** `reject` で試す復旧（コードなしの結び直し）を登録する。復旧が通ったら、自分で `set` する。 */
  setRecover(fn: () => Promise<boolean>): void;
}

export function createNodeCredentialStore(): NodeCredentialStore {
  let current: NodeCredential | undefined;
  let recover: (() => Promise<boolean>) | undefined;
  const listeners = new Set<(c: NodeCredential | undefined) => void>();
  const emit = (): void => {
    for (const fn of listeners) {
      try {
        fn(current);
      } catch {
        // 受け手の失敗で、入れ物を変えない
      }
    }
  };
  return {
    get: () => current,
    set(c) {
      current = Object.freeze({ nodeId: c.nodeId, token: c.token });
      emit();
    },
    clear() {
      if (current === undefined) return;
      current = undefined;
      emit();
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async reject(token) {
      if (current === undefined) return false;
      if (current.token !== token) return true;
      let recovered = false;
      try {
        recovered = (await recover?.()) === true;
      } catch {
        // 復旧の失敗は、空にする側へ落とす
      }
      if (recovered) return true;
      if (current?.token === token) this.clear();
      return false;
    },
    setRecover(fn) {
      recover = fn;
    },
  };
}
