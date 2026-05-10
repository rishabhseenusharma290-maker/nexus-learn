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
  echo Copy .env.example to .env and add your GEMINI_API_KEY first.
  pause
  exit /b 1
)

echo Starting Nexus Learn...
echo The server will print the exact local URL and open the correct port automatically.
echo If an older Node process is still using 3001, the app may move to the next free port.

start "Nexus Learn Server" cmd /k "cd /d %~dp0 && set NEXUS_AUTO_OPEN=1 && node server.js"

endlocal
