@echo off
chcp 65001 >nul
title Token Monitor
cd /d "%~dp0server"

tasklist /FI "WINDOWTITLE eq Token Monitor" 2>NUL | find /I /N "node.exe">NUL
if "%ERRORLEVEL%"=="0" (
    echo 服务已在运行: http://localhost:3000
    timeout /t 3
    exit
)

echo 启动 Token Monitor 后端...
start "Token Monitor" /MIN node server.js
echo 后端已启动: http://localhost:3000
timeout /t 3