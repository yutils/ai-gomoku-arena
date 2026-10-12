@echo off
chcp 65001 >nul
title AIvsAI
cd /d "%~dp0"
start "" http://127.0.0.1:8899
node server\server.js
pause