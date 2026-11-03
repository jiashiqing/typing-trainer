@echo off
cd /d "%~dp0"
chcp 65001 >nul
title Typing Trainer - Status

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js not found. Run start.bat first.
  pause
  exit /b 1
)

node tools\svc.js status --wait
pause >nul
