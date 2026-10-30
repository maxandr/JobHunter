@echo off
rem Builds job-hunter.exe in this folder: one file with Node.js, the web page (public\) and the browser extension inside,
rem so users don't need to install Node. Needs Node.js 20+ and internet (npx downloads esbuild and postject).
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js not found. Install it from https://nodejs.org & exit /b 1)
if exist dist rmdir /s /q dist
mkdir dist

echo Bundling the code...
call npx --yes esbuild main.js --bundle --platform=node --format=cjs --outfile=dist\bundle.js --log-level=warning || exit /b 1

echo Building the executable...
rem Files of public\ and extension\ go into the exe as assets "public/<name>" and "extension/<name>" (see lib\store.js).
node -e "const fs=require('fs');const assets={};for(const d of ['public','extension'])for(const f of fs.readdirSync(d))assets[d+'/'+f]=d+'/'+f;fs.writeFileSync('dist/extension-files.json',JSON.stringify(fs.readdirSync('extension')));assets['extension-files.json']='dist/extension-files.json';fs.writeFileSync('dist/sea-config.json',JSON.stringify({main:'dist/bundle.js',output:'dist/sea-prep.blob',disableExperimentalSEAWarning:true,assets}))" || exit /b 1
node --experimental-sea-config dist\sea-config.json || exit /b 1
for /f "delims=" %%i in ('node -p "process.execPath"') do copy /y "%%i" dist\job-hunter.exe >nul
call npx --yes postject dist\job-hunter.exe NODE_SEA_BLOB dist\sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 || exit /b 1
move /y dist\job-hunter.exe job-hunter.exe >nul || (echo Cannot replace job-hunter.exe: close its window and run build.bat again. & exit /b 1)
rmdir /s /q dist
echo.
echo Done: job-hunter.exe
