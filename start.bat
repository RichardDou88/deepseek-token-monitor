@echo off
title Token Monitor
cd /d "%~dp0server"

tasklist /FI "WINDOWTITLE eq Token Monitor" 2>NUL | find /I /N "node.exe">NUL
if "%ERRORLEVEL%"=="0" (
    echo Server already running: http://localhost:3000
    timeout /t 3
    exit
)

echo Starting Token Monitor backend...
start "Token Monitor" /MIN node server.js
echo Backend started: http://localhost:3000
timeout /t 3