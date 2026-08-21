@echo off
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" .
