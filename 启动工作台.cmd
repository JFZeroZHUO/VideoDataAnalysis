@echo off
cd /d "%~dp0"
title Maternal AI Video Radar

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Please install Node.js 22 or newer.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo First run: installing local dependencies. Please keep the network connected.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] Dependency installation failed. Check the network and try again.
    pause
    exit /b 1
  )
)

if not exist "dist\index.html" (
  echo Building the dashboard...
  call npm run build
  if errorlevel 1 (
    echo [ERROR] Dashboard build failed.
    pause
    exit /b 1
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-server.ps1"
if errorlevel 1 (
  echo [ERROR] The dashboard could not start. See data\server-error.log.
  pause
  exit /b 1
)

exit /b 0
