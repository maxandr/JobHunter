@echo off
rem Registers a daily Windows scheduled task that searches for new jobs (default 09:00).
rem Usage: schedule-daily-search.bat [HH:MM]
cd /d "%~dp0"
set TIME_AT=%1
if "%TIME_AT%"=="" set TIME_AT=09:00
for /f "delims=" %%i in ('where node') do (set "NODE=%%i" & goto :found)
echo Node.js not found in PATH. & pause & exit /b 1
:found
schtasks /Create /F /SC DAILY /ST %TIME_AT% /TN "JobHunter Daily Search" /TR "\"%NODE%\" \"%~dp0search.js\""
if errorlevel 1 (echo Failed to create the task. & pause & exit /b 1)
echo.
echo Done: "JobHunter Daily Search" runs every day at %TIME_AT% while you are logged in.
echo Results appear in the app; log is in data\search.log
pause
