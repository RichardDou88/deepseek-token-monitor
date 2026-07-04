@echo off
title Token Monitor 安装
echo ======================================
echo   DeepSeek Token Monitor 安装程序
echo ======================================
echo.

:: Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 需要 Node.js
    echo 下载: https://nodejs.org/zh-cn/download/
    start https://nodejs.org/zh-cn/download/
    pause
    exit /b 1
)
echo [OK] Node.js

:: 安装依赖
cd /d "%~dp0server"
echo 安装依赖...
call npm install

:: 开机自启
echo.
echo 是否设置开机自动启动? (Y/N)
choice /c YN /n /m "选择: "
if errorlevel 2 goto skip_auto

:: 创建启动快捷方式
set STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set SHORTCUT=%STARTUP_DIR%\TokenMonitor.lnk

powershell -Command "$s=(New-Object -COM WScript.Shell).CreateShortcut('%SHORTCUT%');$s.TargetPath='%~dp0start.bat';$s.WorkingDirectory='%~dp0';$s.WindowStyle=7;$s.Description='Token Monitor';$s.Save()"

echo [OK] 已添加开机自启

:skip_auto
echo.
echo ======================================
echo   安装完成！
echo ======================================
echo.
echo 1. 双击 start.bat 启动服务
echo 2. 浏览器打开 http://localhost:3000 配置 API
echo 3. 加载 Wallpaper Engine 壁纸
echo.
start "" http://localhost:3000
pause