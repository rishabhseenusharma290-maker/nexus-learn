@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on this machine.
  echo Install Node.js 18+ and run this launcher again.
  pause
  exit /b 1
)

if not exist ".env" (
  echo No .env file found.
  echo Copy .env.example to .env and add your OPENAI_API_KEY first.
  pause
  exit /b 1
)

start "Nexus Learn Server" cmd /k "cd /d %~dp0 && node server.js"
timeout /t 2 /nobreak >nul
start "" "http://localhost:3001/"

endlocal
