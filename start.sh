#!/bin/sh
set -eu

# Resolve relative configuration paths from the project, not the caller's directory.
CDPATH= cd -- "$(dirname -- "$0")"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '找不到 Node.js，請先安裝 Node.js 22.13 或更新版本。' >&2
  exit 1
fi

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) { console.error("需要 Node.js 22.13 或更新版本（內建 node:sqlite）。"); process.exit(1); }'

if ! node --input-type=module -e 'await import("ws"); await import("yaml"); import.meta.resolve("@types/node/package.json"); import.meta.resolve("@types/ws/package.json");' >/dev/null 2>&1 \
  || ! ./node_modules/.bin/tsc --version >/dev/null 2>&1; then
  if ! command -v npm >/dev/null 2>&1; then
    printf '%s\n' '找不到 npm，無法自動安裝依賴；請先安裝 npm 後重試。' >&2
    exit 1
  fi
  printf '%s\n' '依賴無法載入，正在依照 lockfile 自動安裝…'
  npm ci --include=dev --ignore-scripts
fi

./node_modules/.bin/tsc -p tsconfig.json
exec node dist/src/main.js "$@"
