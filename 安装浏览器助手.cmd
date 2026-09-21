@echo off
setlocal
cd /d "%~dp0"
start "" chrome://extensions/
start "" explorer.exe "%~dp0browser-helper"
echo Chrome extensions and the browser-helper folder have been opened.
echo Enable Developer mode, choose Load unpacked, then select the browser-helper folder.
pause
