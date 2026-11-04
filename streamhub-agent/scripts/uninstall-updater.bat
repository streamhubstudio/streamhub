@echo off
echo Uninstalling StreamHub Updater Service...
streamhub-updater.exe --uninstall
if %ERRORLEVEL% NEQ 0 (
    echo Failed to uninstall service. Run as Administrator.
    pause
    exit /b 1
)
echo Done.
pause
