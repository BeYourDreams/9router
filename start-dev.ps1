$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
git pull --ff-only || { Write-Error "拉取失败：请先提交或暂存本地更改"; exit 1 }
if (-not (Test-Path node_modules)) { npm install }
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm run dev
Pop-Location
