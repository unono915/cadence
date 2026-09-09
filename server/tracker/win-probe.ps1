# Cadence 활동 추적 프로브 (Windows)
#
# 지정된 주기마다 포그라운드 창의 제목/프로세스와 마지막 입력 이후 경과 시간을
# JSON Lines 로 stdout 에 출력한다. Node 쪽 tracker.mjs 가 이 스트림을 읽는다.
#
# 사용: powershell -NoProfile -ExecutionPolicy Bypass -File win-probe.ps1 -IntervalMs 4000
#
# 읽기 전용이다 — 창을 조작하거나 입력을 보내지 않으며, 키 입력 내용은 절대 읽지 않는다.
# (GetLastInputInfo 는 "마지막 입력 시각"만 돌려주고 입력 내용은 알려주지 않는다.)

param(
  [int]$IntervalMs = 4000
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class CadenceProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("kernel32.dll")] public static extern uint GetTickCount();

  public static string ForegroundTitle() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return "";
    StringBuilder sb = new StringBuilder(1024);
    GetWindowTextW(h, sb, 1024);
    return sb.ToString();
  }

  public static uint ForegroundPid() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return 0;
    uint p;
    GetWindowThreadProcessId(h, out p);
    return p;
  }

  public static uint IdleMs() {
    LASTINPUTINFO l = new LASTINPUTINFO();
    l.cbSize = (uint)Marshal.SizeOf(l);
    if (!GetLastInputInfo(ref l)) return 0;
    // GetTickCount 는 ~49.7일마다 순환한다. 부호 없는 뺄셈이라 순환 시에도 값이 맞다.
    return unchecked(GetTickCount() - l.dwTime);
  }
}
"@

# 프로세스 이름 → 표시 이름 캐시.
#
# 비싼 것은 FileVersionInfo 조회이고, 그 값은 **실행 파일**에 딸린 것이지 프로세스에
# 딸린 것이 아니다. 그래서 pid 가 아니라 프로세스 이름으로 캐시한다.
#
# 예전에는 pid 로 캐시했는데, 윈도우는 pid 를 재사용한다. 짧게 살다 죽는 프로세스가
# 많은 기계를 며칠씩 켜 두면 같은 번호가 다른 프로그램에 다시 붙고, 그때부터 그 시간이
# **엉뚱한 앱 이름으로 기록된다.** 화면에는 그럴듯한 앱 이름이 뜨므로 아무도 눈치채지 못한다.
$nameCache = @{}

# 이름을 알아내지 못한 창은 빈 값으로 내보낸다.
# 'Unknown' 같은 이름을 지어내면 Node 쪽에서 그것이 진짜 앱인 줄 알고 기록해 버리고,
# 나중에 "많이 쓴 앱" 목록에 Unknown 이 올라온다. 판단은 tracker.mjs 가 한다.
$blank = @{ proc = ''; app = '' }

function Get-DisplayName([uint32]$procId) {
  # 포그라운드 창이 없다 — 잠금 화면, 데스크톱 전환 중, 세션이 다른 경우.
  if ($procId -eq 0) { return $blank }

  # 프로세스 조회는 매번 한다 — 싼 쪽이고, pid 가 지금 무엇인지는 이것으로만 알 수 있다.
  $proc = $null
  try { $proc = Get-Process -Id $procId -ErrorAction Stop } catch { }

  # 조회하는 사이에 프로세스가 사라진 경우. 한 폴링짜리 과도기다.
  if ($null -eq $proc) { return $blank }

  $key = $proc.ProcessName
  if ($nameCache.ContainsKey($key)) { return $nameCache[$key] }

  # 비싼 쪽은 여기다 — 실행 파일마다 한 번만 한다.
  $friendly = $null
  try {
    if ($proc.MainModule -and $proc.MainModule.FileVersionInfo) {
      $friendly = $proc.MainModule.FileVersionInfo.FileDescription
    }
  } catch { }
  if ([string]::IsNullOrWhiteSpace($friendly)) { $friendly = $key }
  $entry = @{ proc = $key; app = $friendly }

  # 캐시가 무한정 커지지 않도록 제한 (프로그램 종류 수만큼이라 원래 크지 않다).
  if ($nameCache.Count -gt 400) { $nameCache.Clear() }
  $nameCache[$key] = $entry
  return $entry
}

# 준비 완료 신호 — Node 가 프로브 기동을 확인하는 데 쓴다.
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

while ($true) {
  try {
    $procId = [CadenceProbe]::ForegroundPid()
    $names  = Get-DisplayName $procId
    $sample = [ordered]@{
      t      = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      title  = [CadenceProbe]::ForegroundTitle()
      proc   = $names.proc
      app    = $names.app
      # [int] 로 받으면 24.8일 넘게 자리를 비웠을 때 uint 가 int 범위를 넘어 변환이 터진다.
      # 그러면 그때부터 샘플이 한 건도 나가지 않는다 — [long] 이면 그런 일이 없다.
      idleMs = [long][CadenceProbe]::IdleMs()
    }
    [Console]::Out.WriteLine(($sample | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
  } catch {
    # 일시적 오류(잠금 화면, 권한 등)는 건너뛴다. 프로브는 계속 살아 있어야 한다.
    [Console]::Error.WriteLine("probe-error: " + $_.Exception.Message)
  }
  Start-Sleep -Milliseconds $IntervalMs
}
