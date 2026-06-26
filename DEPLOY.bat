@echo off
echo ================================================
echo  CQM v2.4 - Deploy to GitHub
echo ================================================
echo.

REM Run this bat file from inside D:\CustomerQueryManagement

cd /d %~dp0

echo [1] Removing old source files...
rmdir /s /q backend\src 2>nul
del /q backend\server.js 2>nul
del /q frontend\index.html 2>nul

echo [2] Copying new files from this zip...
REM Files are already here since this bat is inside the extracted zip
REM Nothing to copy - we are the source

echo [3] Staging all changes...
git add -A

echo.
echo [4] Status:
git status

echo.
echo [5] Committing...
git commit -m "BUILD v2.4 - BestBuy JSON API scraper, Documents tab, Apify web-scraper, remove manual entries"

echo.
echo [6] Pushing to GitHub...
git push origin main

echo.
echo ================================================
echo  DONE! Check Render dashboard for redeploy.
echo  URL: https://dashboard.render.com
echo ================================================
pause
