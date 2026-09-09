@echo off
rem Cadence 실행 — 서버를 켜고 기본 브라우저로 콘솔을 엽니다.
setlocal
cd /d "%~dp0"

if "%CADENCE_PORT%"=="" set CADENCE_PORT=4321

where node >nul 2>nul
if errorlevel 1 (
  echo [Cadence] Node.js 를 찾을 수 없습니다. https://nodejs.org 에서 22.5 이상을 설치하세요.
  pause
  exit /b 1
)

echo [Cadence] 서버를 시작합니다... http://127.0.0.1:%CADENCE_PORT%

rem 브라우저는 서버가 직접 연다.
rem 여기서 2초를 세고 무조건 열면, 서버가 뜨지 못한 날에도 브라우저가 열려
rem 사용자는 이 창의 안내 대신 "연결할 수 없음" 을 보게 된다. 포트를 다른 프로그램이
rem 쓰고 있을 때는 남의 페이지가 열려 Cadence 인 척하기까지 한다.
set CADENCE_OPEN=1
node server\index.mjs
set EXITCODE=%errorlevel%

echo.
if "%EXITCODE%"=="0" (
  rem 정상 종료이거나, 이미 켜져 있어서 조용히 물러난 경우. 창을 붙잡아 둘 이유가 없다.
  exit /b 0
)
echo [Cadence] 서버가 오류로 종료되었습니다 ^(코드 %EXITCODE%^).
pause
