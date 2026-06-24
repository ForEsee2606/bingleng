@echo off
cd /d "%~dp0"

where node >nul 2>&1
if %errorlevel% neq 0 (
  echo [ERROR] Node.js not found. Please install from: https://nodejs.org
  pause
  exit /b
)

if not exist "node_modules" (
  echo Installing dependencies...
  npm install
)

echo Stopping any existing server on port 3000...
for /f "tokens=5" %%a in ('netstat -aon ^| find ":3000" ^| find "LISTENING"') do (
  taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo.
echo ==========================================
echo  Game server started!
echo  Open in browser: http://localhost:3000
echo ==========================================
echo.
echo  LAN play: share http://[your-LAN-IP]:3000
echo  Internet: run "ngrok http 3000" in another window
echo.
echo  Press Ctrl+C to stop
echo ==========================================
echo.

node server.js

pause
