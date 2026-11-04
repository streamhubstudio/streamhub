@echo off
echo Installing StreamHub Updater Service...
streamhub-updater.exe --install
if %ERRORLEVEL% NEQ 0 (
    echo Failed to install service. Run as Administrator.
    pause
    exit /b 1
)
echo.
echo Starting service...
net start StreamHubUpdater
echo Done.
pause
