@echo off
cd /d "%~dp0"

rem İlk kurulum yoksa yap
if not exist node_modules (
  echo Kurulum yapiliyor...
  call npm install
)

rem Sunucuyu arka pencerede baslat
start "DUYURU-SERVER" cmd /c node server.js

rem Sunucu ayaga kalksın diye kisa bekle
timeout /t 2 >nul

rem Duyuru ekranı ve Admin paneli AYRI pencerelerde (veya sekmelerde) acilsin
start "" "http://localhost:3000/"
start "" "http://localhost:3000/admin"
