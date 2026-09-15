@echo off
cd /d "%~dp0"
setlocal

echo ============================================
echo   996 Kefu Manager - Build Installer
echo ============================================
echo.

echo [1/2] Cleaning leftovers from an interrupted build...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*electron-builder*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Get-ChildItem $env:TEMP -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'eb-dl-*' } | ForEach-Object { [System.IO.Directory]::Delete($_.FullName, $true) }; exit 0"
echo       done.
echo.

echo [2/2] Building (electron-vite build + electron-builder --win)...
call npm run pack
if errorlevel 1 goto fail

echo.
echo ============================================
echo   BUILD OK - installer in dist\ :
dir /b "dist\996kefu-*-setup.exe"
echo ============================================
pause
exit /b 0

:fail
echo.
echo ============================================
echo   BUILD FAILED - please copy the error above
echo ============================================
pause
exit /b 1
