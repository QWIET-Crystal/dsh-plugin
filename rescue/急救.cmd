@echo off
rem dsh-doctor rescue kit launcher.
rem ASCII only: cmd.exe decodes .cmd with the system code page (GBK here), so any
rem non-ASCII byte would be split into garbage commands. Chinese lives in rescue.ps1
rem (UTF-8 with BOM) which PowerShell reads correctly.
start "" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0rescue.ps1"
exit /b 0
