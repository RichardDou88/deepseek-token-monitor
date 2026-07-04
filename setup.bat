@echo off
title Token Monitor Setup
echo ======================================
echo   DeepSeek Token Monitor Setup
echo ======================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found
    echo Download: https://nodejs.org/
    start https://nodejs.org/
    pause
    exit /b 1
)
echo [OK] Node.js found

cd /d "%~dp0server"
echo Installing dependencies...
call npm install

echo.
echo Auto-start with Windows? (Y/N)
choice /c YN /n /m "Choose: "
if errorlevel 2 goto skip_auto

set STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set SHORTCUT=%STARTUP_DIR%\TokenMonitor.lnk
powershell -Command "$s=(New-Object -COM WScript.Shell).CreateShortcut('%SHORTCUT%');$s.TargetPath='%~dp0start.bat';$s.WorkingDirectory='%~dp0';$s.WindowStyle=7;$s.Description='Token Monitor';$s.Save()"
echo [OK] Auto-start enabled

:skip_auto
echo.
echo ======================================
echo   Setup Complete!
echo ======================================
echo.
echo 1. Run start.bat to launch backend
echo 2. Open http://localhost:3000 to config API
echo 3. Load Wallpaper Engine wallpaper
echo.
start "" http://localhost:3000
pause