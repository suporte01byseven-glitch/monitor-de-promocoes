@echo off
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>&1
if %errorlevel%==0 (
  start "Monitor de Promoções" http://127.0.0.1:8765
  py -3 server.py
) else (
  where python >nul 2>&1
  if errorlevel 1 (
    echo Python 3 nao encontrado. Instale em https://www.python.org/downloads/
    pause
    exit /b 1
  )
  start "Monitor de Promoções" http://127.0.0.1:8765
  python server.py
)
