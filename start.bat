@echo off
rem Starts Job Hunter and opens it in the browser. Keep this window open while you use the app.
rem Type "restart" (or "r") in this window to restart the server, "exit" (or "q") to stop it.
chcp 65001 >nul
cd /d "%~dp0"
rem Lets the web page's "Restart server" button work: this script starts the server again.
set JOB_HUNTER_SUPERVISED=1
where node >nul 2>nul || (echo Node.js not found. Install it from https://nodejs.org & pause & exit /b 1)
node server.js --open
:loop
rem Exit code 75 = restart requested from the console.
if %errorlevel%==75 (
  node server.js
  goto loop
)
pause
