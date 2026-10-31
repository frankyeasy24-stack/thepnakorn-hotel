@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Thepnakorn Hotel - Deploy to Cloudflare
where node >/dev/null 2>/dev/null || (echo Node.js not found. Install it from https://nodejs.org then run this file again. & pause & exit /b 1)
node deploy.mjs
echo.
pause
