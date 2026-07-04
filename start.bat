@echo off
chcp 65001 >nul
title DeepSeek Token Monitor
echo.
echo  ======================================
echo    DeepSeek Token Monitor v2.0
echo  ======================================
echo.
echo  正在启动后端服务...

cd /d "%~dp0server"
start "" /MIN node server.js

echo  后端已启动: http://localhost:3000
echo.
echo  接下来:
echo    1. 打开 Wallpaper Engine
echo    2. 点击"从文件打开"
echo    3. 选择: wallpaper-engine\wallpaper.html
echo.
echo  或浏览器打开 http://localhost:3000 配置 API
echo.
timeout /t 5
