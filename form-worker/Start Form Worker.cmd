@echo off
rem Form Worker: checks lead websites for a contact form and sends contact-form messages on this PC.
rem Restarts itself if it ever stops. Exit code 2 means nothing to do or not set up, and it stops.
title Form Worker
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 22 or newer from nodejs.org, then start this again.
  pause
  exit /b 2
)

if not exist node_modules (
  echo Installing the browser library ^(first start only^)...
  call npm install --omit=dev
  if errorlevel 1 (
    echo npm install failed. See the messages above.
    pause
    exit /b 1
  )
)

:run
node worker.mjs
if errorlevel 2 if not errorlevel 3 goto done
echo The worker stopped. Restarting in 15 seconds...
timeout /t 15 /nobreak >nul
goto run

:done
pause
