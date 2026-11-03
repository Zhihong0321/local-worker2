@echo off
rem Local Gmap Worker. Keeps the worker running; it restarts itself if it ever stops.
title Local Gmap Worker
:run
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\worker.ps1"
if errorlevel 2 if not errorlevel 3 goto done
echo The worker stopped. Restarting in 15 seconds...
timeout /t 15 /nobreak >nul
goto run
:done
pause
