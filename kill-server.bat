@echo off
echo Looking for background remote server processes on port 3000...

for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do (
    echo Killing process with PID %%a...
    taskkill /F /PID %%a
)

echo Done! Server stopped.
pause
