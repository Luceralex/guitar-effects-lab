@echo off
rem ============================================================
rem  GuitarLab launcher: start backend (if not running) + open UI
rem  - Port 8765 already listening  -> backend alive, just open page
rem  - Otherwise start pythonw server.py (no console window)
rem  - Closing the page keeps the backend available for 10 minutes, then it exits
rem ============================================================
cd /d "%~dp0"

netstat -ano | findstr ":8765" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 goto open

start "" /b pythonw server.py

set /a tries=0
:wait
ping -n 2 127.0.0.1 >nul
curl -s -o nul http://127.0.0.1:8765/api/health 2>nul
if %errorlevel%==0 goto open
set /a tries+=1
if %tries% lss 10 goto wait

echo Backend failed to start (check Python deps: fastapi uvicorn numpy)
pause
exit /b 1

:open
start "" "http://127.0.0.1:8765/"
exit /b 0
