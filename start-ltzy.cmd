@echo off
setlocal
cd /d "%~dp0"
python server.py --port 8765
if errorlevel 1 pause
