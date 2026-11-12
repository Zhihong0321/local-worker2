@echo off
rem Starts the Form Worker minimised every time you sign in to Windows. Run once, on this PC.
powershell.exe -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\Form Worker.lnk'); $s.TargetPath='%~dp0Start Form Worker.cmd'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Description='Form Worker'; $s.Save(); Write-Host 'Autostart is on.'"
pause
