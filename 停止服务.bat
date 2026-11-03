@echo off
cd /d "%~dp0"
chcp 65001 >nul
title Typing Trainer - Stop

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js not found. Run start.bat first.
  pause
  exit /b 1
)

node tools\svc.js stop --wait
pause >nul
