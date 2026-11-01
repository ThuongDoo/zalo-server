@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
if not exist config.json (
  echo Chua co file config.json. Copy config.example.json thanh config.json va dien thong tin.
  pause
  exit /b
)
node index.js
pause
