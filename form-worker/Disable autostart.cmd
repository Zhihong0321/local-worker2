@echo off
rem Removes the Form Worker's sign-in start. The worker itself is not stopped.
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Form Worker.lnk" 2>nul
echo Autostart is off.
pause
