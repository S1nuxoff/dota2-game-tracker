@echo off
rem Uploads what the game changed since the last export, from this PC's Dota 2
powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0export-local.ps1" -Mode update
