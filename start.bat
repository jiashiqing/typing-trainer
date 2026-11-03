@echo off
chcp 936 >nul
title 全县中小学生打字练习系统
cd /d "%~dp0"

echo.
echo  ============================================================
echo    全县中小学生打字练习系统  ·  教师机服务
echo  ============================================================
echo.
echo   查看运行状态：双击「查看服务状态.bat」
echo   停止服务：    双击「停止服务.bat」（或在这个窗口按 Ctrl + C）
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [!] 这台电脑没有检测到 Node.js，无法启动。
  echo.
  echo      请到 https://nodejs.org 下载 LTS 版本安装，
  echo      安装完成后重新双击本文件即可。
  echo.
  pause
  exit /b 1
)

node server.js

echo.
echo  服务已停止，数据已保存。
pause
