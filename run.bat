@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo Installing...
  call npm install
)
node index.js %*
pause
