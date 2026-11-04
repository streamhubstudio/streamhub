@echo off
echo Installing StreamHub Agent service...
"%~dp0..\streamhub-agent.exe" --install
if %ERRORLEVEL% EQU 0 (
    echo Starting service...
    net start StreamHubAgent
)
pause
