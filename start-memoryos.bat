@echo off
chcp 65001 >nul
cd /d "C:\Users\WYX\Desktop\MemoryOS"
powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue)) { Start-Process -WindowStyle Hidden -FilePath 'C:\Users\WYX\Desktop\MemoryOS\resources\memoryos\runtime\node.exe' -ArgumentList 'C:\Users\WYX\Desktop\MemoryOS\resources\memoryos\dist\dashboard.js' }"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8787/?token=a076caefded8c2972cfe6c8c5a88fa20bef101afdac0d2df"
timeout /t 1 /nobreak >nul
exit
