@echo off
title MartFlow AI -> 10-Sec WhatsApp AI Command Center
cd /d "%~dp0"

echo ==============================================================
echo   MartFlow AI -> 10-Second WhatsApp AI Demo (Windows Launcher)
echo ==============================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [!] Node.js is not installed on your Windows PC yet!
    echo [!] Opening https://nodejs.org — Download & install "LTS" (takes 60 seconds), then double-click this file again.
    start https://nodejs.org/
    pause
    exit /b
)

for /f "tokens=*" %%i in ('node -v') do set NODEVER=%%i
echo [OK] Detected Node.js %NODEVER%

if not exist "node_modules" (
    echo [1/2] Installing WhatsApp & Server packages (takes ~15 seconds first time)...
    call npm install
)

echo [2/2] Opening Dashboard at http://localhost:3000 ...
start "" http://localhost:3000
node server.js
pause
