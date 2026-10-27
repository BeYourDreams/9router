#!/usr/bin/env bash
# ponytail: shortcut = pull + lazy install + dev. Ceiling: dependency changes still need a manual `npm install`; upgrade path is to drop the `[ -d node_modules ]` guard if you want fresh installs every run.
set -euo pipefail
cd "$(dirname "$0")"

git pull --ff-only || { echo "拉取失败：请先提交或暂存本地更改"; exit 1; }
[ -d node_modules ] || npm install
[ -f .env ] || cp .env.example .env
npm run dev
