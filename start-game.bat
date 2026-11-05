@echo off
cd /d "%~dp0"
echo Slop Tehran: http://localhost:8000/  (close this window to stop)
start "" http://localhost:8000/
python -m http.server 8000 || py -m http.server 8000
