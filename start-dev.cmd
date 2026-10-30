@echo off
rem Double-click launcher for `npm start`.
rem It used to flash and vanish: `npm` on Windows resolves to npm.cmd, and a .cmd
rem invoked from a batch file transfers control instead of returning — so the
rem `pause` at the bottom was dead code and any error closed the window instantly.
rem `call` makes npm return here. `%~dp0` keeps Explorer's launch folder from
rem becoming the working directory (npm would then run in the wrong project).
cd /d "%~dp0"

call npm start
echo.
echo [9router] server exited (errorlevel %errorlevel%).
pause
