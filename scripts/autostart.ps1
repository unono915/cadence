# Cadence 로그인 시 자동 실행 등록 / 해제
#
#   등록:  powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1
#   해제:  powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Remove
#
# 사용자 계정의 시작프로그램 폴더에 바로가기를 만듭니다. 관리자 권한은 필요 없고,
# 레지스트리나 시스템 설정은 건드리지 않습니다. 해제는 바로가기를 지우는 것이 전부입니다.

param(
  [switch]$Remove,
  [int]$Port = 4321
)

$ErrorActionPreference = 'Stop'

$root      = Split-Path -Parent $PSScriptRoot
$startup   = [Environment]::GetFolderPath('Startup')
$shortcut  = Join-Path $startup 'Cadence.lnk'
$launcher  = Join-Path $root 'scripts\run-hidden.vbs'

if ($Remove) {
  if (Test-Path $shortcut) {
    Remove-Item $shortcut -Force
    Write-Host "[Cadence] 자동 실행을 해제했습니다: $shortcut"
  } else {
    Write-Host "[Cadence] 등록된 자동 실행이 없습니다."
  }
  exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js 를 찾을 수 없습니다. https://nodejs.org 에서 22.5 이상을 설치한 뒤 다시 실행하세요."
}

# 콘솔 창 없이 서버를 띄우는 최소 런처를 만든다.
# VBS 문자열 안에서는 큰따옴표를 두 번 써서 이스케이프한다.
$rootEscaped = $root.Replace('"', '""')
$vbsLines = @(
  "' Cadence 를 콘솔 창 없이 실행합니다. scripts\autostart.ps1 이 생성합니다."
  'Set shell = CreateObject("WScript.Shell")'
  "shell.CurrentDirectory = ""$rootEscaped"""
  "shell.Environment(""PROCESS"")(""CADENCE_PORT"") = ""$Port"""
  'shell.Run "node server\index.mjs", 0, False'
)
Set-Content -Path $launcher -Value $vbsLines -Encoding UTF8

$wsh = New-Object -ComObject WScript.Shell
$lnk = $wsh.CreateShortcut($shortcut)
$lnk.TargetPath       = "$env:SystemRoot\System32\wscript.exe"
$lnk.Arguments        = "`"$launcher`""
$lnk.WorkingDirectory = $root
$lnk.Description      = 'Cadence — 로컬 업무 생산성 콘솔'
$lnk.IconLocation     = "$env:SystemRoot\System32\shell32.dll,44"
$lnk.Save()

Write-Host "[Cadence] 자동 실행을 등록했습니다."
Write-Host "  바로가기 : $shortcut"
Write-Host "  실행     : node server\index.mjs (포트 $Port, 콘솔 창 없음)"
Write-Host "  주소     : http://127.0.0.1:$Port"
Write-Host ""
Write-Host "지금 바로 켜려면: node server\index.mjs"
Write-Host "해제하려면      : powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Remove"
