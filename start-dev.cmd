@echo off
rem Double-click launcher for the sandbox dev server on 20127.
rem --sandbox keeps dev's compile cache in .next-sandbox, so it never touches the
rem production instance on 20128 (whose working dir is .next/standalone, which
rem `next build` would delete).
cd /d "%~dp0"

node scripts\dev-server.mjs --sandbox --port 20127
echo.
echo [9router] dev server exited (errorlevel %errorlevel%).
pause
