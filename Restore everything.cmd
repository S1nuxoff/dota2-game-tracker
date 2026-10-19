@echo off
rem Uploads everything again from this PC's Dota 2, as on the first run (when the datasets were lost)
echo This exports and uploads EVERYTHING again: models, data, sounds, particles, voice lines and scenes.
echo It takes many hours. Close this window to cancel.
pause
powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0export-local.ps1" -Mode all
