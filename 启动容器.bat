@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found
  pause
  exit /b 1
)
if not exist "node_modules\electron" (
  echo installing electron...
  call npm install
)
call npm start
if errorlevel 1 pause
