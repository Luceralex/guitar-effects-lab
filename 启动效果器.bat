@echo off
rem ============================================================
rem  GuitarLab launcher: start backend (if not running) + open UI
rem  - Local health check succeeds -> backend alive, just open page
rem  - Otherwise start pythonw server.py (no console window)
rem  - Closing the page keeps the backend available for 10 minutes, then it exits
rem ============================================================
cd /d "%~dp0"

curl.exe --noproxy "*" --fail --silent --max-time 2 -o nul http://127.0.0.1:8765/api/health 2>nul
if not errorlevel 1 goto open

where pythonw.exe >nul 2>&1
if errorlevel 1 goto missingpython
python.exe -c "import fastapi, uvicorn, numpy" >nul 2>&1
if errorlevel 1 goto missingdeps

rem Let this launcher open the page once the backend is actually ready.
set "GUITARLAB_NO_BROWSER=1"
start "" /b pythonw.exe "%~dp0server.py"

set /a tries=0
:wait
ping -n 2 127.0.0.1 >nul
curl.exe --noproxy "*" --fail --silent --max-time 2 -o nul http://127.0.0.1:8765/api/health 2>nul
if not errorlevel 1 goto open
set /a tries+=1
if %tries% lss 10 goto wait

echo Backend failed to start. Check guitarlab.log in this folder.
echo Try running: python server.py
pause
exit /b 1

:missingpython
echo Python was not found. Install Python 3.10+ and add it to PATH.
pause
exit /b 1

:missingdeps
echo Missing Python dependencies. Run in this folder:
echo python -m pip install -r requirements.txt
pause
exit /b 1

:open
start "" "http://127.0.0.1:8765/"
exit /b 0
