@echo off
title LinkedIn sign in
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\linkedin_signin.ps1"
pause
