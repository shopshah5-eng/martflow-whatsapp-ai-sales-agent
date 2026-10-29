@echo off
title Free Public HTTPS Tunnel (Cloudflare) -> Port 3000
cd /d "%~dp0"
echo ====================================================================
echo   Creating FREE Public HTTPS Link for /demo & B2B Push Webhook
echo   (Make sure START_WINDOWS.bat is already running first!)
echo ====================================================================
echo.
echo Look for the link ending in ".trycloudflare.com" below:
echo   - Public Buyer Form: https://xxxx.trycloudflare.com/demo
echo   - B2B Webhook: https://xxxx.trycloudflare.com/api/webhook/b2b
echo.
npx --yes cloudflared tunnel --url http://localhost:3000
pause
