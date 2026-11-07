@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0startup.ps1"
if errorlevel 1 (
  echo Could not enable startup. Run this launcher from your normal Windows account.
)
pause
