@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\worker.ps1" -Autostart off
pause
