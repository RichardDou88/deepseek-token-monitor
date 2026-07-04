@echo off
chcp 65001 >nul
title Token Monitor v2.0 一键安装
echo.
echo  ======================================
echo    Token Monitor v2.0 一键安装
echo  ======================================
echo.

:: 检查 Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [错误] 未检测到 Node.js
    echo  请下载安装: https://nodejs.org/zh-cn/download/
    echo  (选择 LTS 版本)
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node -v') do echo  [OK] Node.js %%i

:: 安装依赖
cd /d "%~dp0server"
echo  正在安装依赖 (express/cors/playwright)...
call npm ci --silent 2>nul
if %errorlevel% neq 0 (
    echo  正在使用 npm install 安装...
    call npm install
)

echo.
echo  ======================================
echo   安装完成！
echo  ======================================
echo.
echo  启动方法:
echo    1. 双击 start.bat
echo    2. 打开 Wallpaper Engine
echo    3. "从文件打开" → wallpaper-engine\wallpaper.html
echo    4. 浏览器打开 http://localhost:3000 配置 API
echo.
pause