#!/usr/bin/env bash
# 実験: Node 同梱の配布物（tar.gz）を作る（リリース・公開はしない）。使い方: bash scripts/dist-build.sh <出力のディレクトリ（絶対パス）>
# - 前提: pnpm install --frozen-lockfile と pnpm build が済んでいる。
# - 同梱する Node は、runner の node ではなく、nodejs.org の公式の配布物を取得し、SHASUMS256.txt と照合して使う
#   （版は DIST_NODE_VERSION。既定 22.20.0。SHASUMS256.txt の署名〔GPG〕は、検証していない）。
# - DIST_VERSION があれば、ファイル名に版を入れる（touryou-<版>-<os>-<arch>.tar.gz。中のディレクトリは touryou-<os>-<arch>）。
set -euo pipefail
out="${1:?出力のディレクトリ（絶対パス）を渡す}"
root="$(cd "$(dirname "$0")/.." && pwd)"
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$arch" in arm64|aarch64) narch=arm64 ;; *) narch=x64 ;; esac
node_version="${DIST_NODE_VERSION:-22.20.0}"
name="touryou-${os}-${arch}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
stage="${work}/${name}"
mkdir -p "${stage}/bin" "${out}"

echo "== 公式の Node ${node_version}（${os}-${narch}）を取得し、SHASUMS256.txt と照合する"
tarball="node-v${node_version}-${os}-${narch}.tar.gz"
curl -fsSL -o "${work}/${tarball}" "https://nodejs.org/dist/v${node_version}/${tarball}"
curl -fsSL -o "${work}/SHASUMS256.txt" "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt"
expected="$(grep "  ${tarball}\$" "${work}/SHASUMS256.txt" | cut -d' ' -f1)"
[ -n "${expected}" ] || { echo "SHASUMS256.txt に ${tarball} がない" >&2; exit 1; }
actual="$(shasum -a 256 "${work}/${tarball}" | cut -d' ' -f1)"
[ "${expected}" = "${actual}" ] || { echo "Node の sha256 が一致しない（期待 ${expected}、実際 ${actual}）" >&2; exit 1; }
tar -C "${work}" -xzf "${work}/${tarball}" "node-v${node_version}-${os}-${narch}/bin/node"
cp "${work}/node-v${node_version}-${os}-${narch}/bin/node" "${stage}/bin/node"

cd "$root"
# daemon の依存（better-sqlite3・MCP SDK など。@touryou/core を含む）を lib/ に 1 度だけ置く。mcp・cli は、その依存で足りる（重複を避ける）
# package-import-method=copy: 置き場（store）からのハードリンクにしない（Linux の既定はハードリンクで、tar にハードリンクとして入り、
# install-runtime.sh の check_types・check_kinds に当たる。macOS の既定〔clone〕は、もともとハードリンクにならない）
pnpm --config.package-import-method=copy --filter=@touryou/daemon --prod --legacy deploy "${stage}/lib"
for p in mcp cli; do
  tmp="$(mktemp -d "${work}/deploy.XXXXXX")"
  pnpm --config.package-import-method=copy --filter="@touryou/${p}" --prod --legacy deploy "${tmp}"
  mkdir -p "${stage}/lib/node_modules/@touryou/${p}"
  cp -R "${tmp}/dist" "${tmp}/package.json" "${stage}/lib/node_modules/@touryou/${p}/"
done
# 配布物では、試験用の抜け道（TOURYOU_CLI_ALLOW_UNVERIFIED）を効かなくする（packages/cli/src/dev-build.ts の DEV_BUILD を false に）。
# 書き換えられなければ（形が変わった）、配布物を作らない
devflag="${stage}/lib/node_modules/@touryou/cli/dist/dev-build.js"
grep -qx 'export const DEV_BUILD = true;' "${devflag}" || { echo "${devflag} に DEV_BUILD = true の行がない" >&2; exit 1; }
sed 's/^export const DEV_BUILD = true;$/export const DEV_BUILD = false;/' "${devflag}" > "${devflag}.tmp" && mv "${devflag}.tmp" "${devflag}"
grep -qx 'export const DEV_BUILD = false;' "${devflag}" || { echo "${devflag} を書き換えられなかった" >&2; exit 1; }
# mcp の直接の依存で、daemon の直接の依存にないもの（zod）を、lib/node_modules の直下に出す（pnpm の隔離のため、ないと解決できない）
for dep in zod; do
  target="$(ls -d "${stage}"/lib/node_modules/.pnpm/${dep}@*/node_modules/${dep} | head -1)"
  [ -n "${target}" ] || { echo "${dep} が .pnpm にない" >&2; exit 1; }
  ln -s "${target#"${stage}"/lib/node_modules/}" "${stage}/lib/node_modules/${dep}"
done
# 実行に要らないものを削る（テスト・ソース・型・ソースマップ・ほかの OS の prebuild・sqlite のソース・.bin のシム・.modules.yaml）
rm -rf "${stage}"/lib/{src,test,tsconfig.json,tsconfig.test.json,vitest.config.ts}
find "${stage}/lib" \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -type f -delete
find "${stage}/lib" -name .bin -type d -prune -exec rm -rf {} +
find "${stage}/lib" -name .modules.yaml -type f -delete
for bs in "${stage}"/lib/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3; do
  rm -rf "${bs}/deps" "${bs}/src"
  find "${bs}/prebuilds" -name '*.node' ! -name "${os}-${narch}.node" -delete
done

echo "== 展開先（lib の外）を指す・行き先のないシンボリックリンクを取り除く（#56）"
# pnpm deploy は、deploy したパッケージ自身（@touryou/daemon）への隠れた hoist のリンク（.pnpm/node_modules/@touryou/daemon）を、
# ビルドしたマシンの workspace のソース（packages/daemon）を指す相対パスで残す。利用者のマシンには行き先がなく、/touryou:setup の check_links が断る。
# lib の中では、だれもこの名前で読まない（lib そのものが daemon）。取り除いたものは、ここに出す
stage_real="$(cd -P "${stage}" && pwd -P)"
nremoved=0
while IFS= read -r l; do
  [ -n "$l" ] || continue
  t="$(readlink "$l")"
  real="$(realpath "$l" 2>/dev/null || true)"
  case "$t" in /*) real="" ;; esac
  case "${real}/" in
    "${stage_real}"/*) [ -e "$l" ] && continue ;;
  esac
  echo "取り除く: ${l#"${stage}"/} -> ${t}"
  rm -f "$l"
  nremoved=$((nremoved + 1))
done <<< "$(find "${stage}" -type l)"
echo "取り除いたリンク: ${nremoved} 本"

echo "== 検査: ネイティブのバイナリが、想定の OS・CPU か"
case "${os}-${narch}" in
  darwin-arm64) want_kind="Mach-O"; want_arch="arm64" ;;
  darwin-x64)   want_kind="Mach-O"; want_arch="x86_64" ;;
  linux-x64)    want_kind="ELF";    want_arch="x86-64" ;;
  linux-arm64)  want_kind="ELF";    want_arch="aarch64" ;;
  *) echo "未対応: ${os}-${narch}" >&2; exit 1 ;;
esac
bins="$( { find "${stage}/lib" -name '*.node' -type f; echo "${stage}/bin/node"; } )"
nbins=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  desc="$(file -b "$f")"
  case "$desc" in
    *"${want_kind}"*"${want_arch}"*) nbins=$((nbins + 1)) ;;
    *) echo "想定外のバイナリ: ${f#"${stage}"/} → ${desc}" >&2; exit 1 ;;
  esac
  if [ "$os" = darwin ]; then
    # システム以外の動的ライブラリ（Homebrew など）に依存していないこと
    if otool -L "$f" | tail -n +2 | awk '{print $1}' | grep -Ev '^(/usr/lib/|/System/|@rpath/|@loader_path/|@executable_path/)'; then
      echo "システム以外の動的ライブラリに依存している: ${f#"${stage}"/}" >&2; exit 1
    fi
  fi
done <<< "$bins"
echo "検査したバイナリ: ${nbins} 個（すべて ${want_kind} ${want_arch}）"
# 要るネイティブを、数ではなく名前で確かめる（node と、better-sqlite3 の同梱の prebuild）。
# better-sqlite3 は npm の配布物に prebuilds/<os>-<arch>.node を含み、install 時のビルド（pnpm が無視する build scripts）は使わない。
[ -f "${stage}/bin/node" ] || { echo "同梱の node がない（bin/node）" >&2; exit 1; }
bs_nodes="$(find "${stage}"/lib/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/prebuilds -name "${os}-${narch}.node" -type f 2>/dev/null || true)"
[ -n "$bs_nodes" ] || { echo "better-sqlite3 のネイティブ（prebuilds/${os}-${narch}.node）が配布物にない" >&2; exit 1; }
# 配布物の node で、better-sqlite3 のネイティブを実際に読めること（:memory: を 1 回開く）
if ! (cd "${stage}/lib" && "${stage}/bin/node" -e 'const D=require("better-sqlite3");const db=new D(":memory:");if(db.prepare("select 1 as x").get().x!==1)throw new Error("select 1");db.close()'); then
  echo "配布物の node で better-sqlite3 を読めない（ネイティブが Node の版・OS・CPU に合わない、または入っていない）" >&2; exit 1
fi
# ほかの OS・CPU のネイティブが残っていないこと
other="$(find "${stage}/lib" -name '*.node' -type f ! -name "${os}-${narch}.node" ! -name '*.node.*' || true)"
[ -z "$other" ] || { echo "ほかの OS・CPU のネイティブが残っている:"; echo "$other"; exit 1; }
# ビルドした場所（一時ディレクトリ・リポジトリ）の絶対パスが残っていないこと（文書中の /Users/ などの一般的な文字列は対象外）
if grep -rIlF -e "${work}" -e "${root}" "${stage}" 2>/dev/null | head -5 | grep .; then
  echo "ビルドした環境のパスが残っている（上のファイル）" >&2; exit 1
fi

# 配布物の版（`touryou --version` などが出す）。DIST_VERSION があればそれ、なければ package.json の version。
# 起動スクリプトに埋め、実行時に TOURYOU_DIST_VERSION として渡す（core の resolveVersion が読む）。
dist_version="${DIST_VERSION:-$(node -e 'process.stdout.write(require(process.argv[1]).version)' "${root}/package.json")}"
launcher() { # $1=コマンド名 $2=node で動かす JS（lib からの相対）
  cat > "${stage}/bin/$1" <<LAUNCH
#!/bin/sh
here="\$(cd "\$(dirname "\$0")/.." && pwd)"
export TOURYOU_DIST_VERSION="${dist_version}"
exec "\$here/bin/node" "\$here/lib/$2" "\$@"
LAUNCH
  chmod +x "${stage}/bin/$1"
}
launcher touryou-daemon dist/bin.js
launcher touryou-mcp node_modules/@touryou/mcp/dist/bin.js
launcher touryou node_modules/@touryou/cli/dist/bin.js

echo "== tar.gz にする（再現性: mtime・所有者を固定。macOS の拡張属性は入れない）"
export COPYFILE_DISABLE=1
find "${stage}" -exec touch -h -t 198001010000 {} +
ver="${DIST_VERSION:+-${DIST_VERSION}}"
file="touryou${ver}-${os}-${arch}.tar.gz"
if tar --version 2>&1 | grep -qi 'bsdtar\|libarchive'; then
  tar -C "${work}" --no-xattrs --uid 0 --gid 0 --numeric-owner -cf - "${name}" | gzip -n > "${out}/${file}"
else
  tar -C "${work}" --sort=name --owner=0 --group=0 --numeric-owner --mtime='1980-01-01 00:00:00' -cf - "${name}" | gzip -n > "${out}/${file}"
fi
(cd "$out" && shasum -a 256 "${file}" > "${file}.sha256")
ls -l "${out}"
cat "${out}/${file}.sha256"
