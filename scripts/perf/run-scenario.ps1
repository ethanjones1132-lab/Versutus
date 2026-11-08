<#
 One performance scenario on a connected Android phone: reset gfxinfo, drive the
 scenario for -Seconds, dump gfxinfo, repeat -Runs times, then judge the runs
 with scripts/perf/gfxinfo.mjs. Raw output lands in docs/perf/raw/<Label>/<Scenario>/
 and the verdict in docs/perf/<Label>-<Scenario>.json.

 Scenarios: idle (no input), scroll (slow drags), fling (fast flicks), drawer
 (edge drags), manual (a notification cues you; you perform it).
 The app must be a release build. The phone must be awake and unlocked.
#>
param(
  [Parameter(Mandatory = $true)][string]$Label,
  [string]$Package = 'com.versutus.app',
  [ValidateSet('idle', 'scroll', 'fling', 'drawer', 'manual')][string]$Scenario = 'idle',
  [string]$ManualPrompt = 'Perform the scenario now.',
  [int]$Runs = 3,
  [int]$Seconds = 10,
  [string]$Serial = '',
  [string]$Adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot\..\..").Path
$out = Join-Path $repo "docs\perf\raw\$Label\$Scenario"
New-Item -ItemType Directory -Force $out | Out-Null

if (-not $Serial) {
  $line = (& $Adb devices) | Select-String '\tdevice$' | Select-Object -First 1
  if (-not $line) { throw 'No adb device. Turn on Wireless debugging, then run: adb connect <ip:port>' }
  $Serial = ($line.Line -split '\s+')[0]
}
function Sh([string]$cmd) { & $Adb -s $Serial shell $cmd }
function Cue([string]$text) {
  & $Adb -s $Serial shell cmd notification post -S bigtext -t 'Versutus perf' vsperf "$text" | Out-Null
}

Sh 'input keyevent KEYCODE_WAKEUP' | Out-Null
Start-Sleep -Seconds 1
$locked = Sh 'dumpsys window' | Select-String -Pattern 'isKeyguardShowing=true|mKeyguardShowing=true|mShowingLockscreen=true' | Select-Object -First 1
if ($locked) { throw 'The phone is locked. Unlock it and run again.' }

$size = (Sh 'wm size') -join ' '
if ($size -match '(\d+)x(\d+)') { $w = [int]$Matches[1]; $h = [int]$Matches[2] } else { $w = 1080; $h = 2340 }
$x = [int]($w / 2); $yHigh = [int]($h * 0.70); $yLow = [int]($h * 0.30); $yMid = [int]($h / 2); $xFar = [int]($w * 0.80)

Sh "monkey -p $Package -c android.intent.category.LAUNCHER 1" | Out-Null
Start-Sleep -Seconds 8   # let the first light and the first paint settle

for ($i = 1; $i -le $Runs; $i++) {
  if ($Scenario -eq 'manual') {
    Cue "Run $i of ${Runs}: $ManualPrompt Starts in 5 s."
    Start-Sleep -Seconds 5
  }
  Sh "dumpsys gfxinfo $Package reset" | Out-Null
  $end = (Get-Date).AddSeconds($Seconds)
  switch ($Scenario) {
    'idle'   { Start-Sleep -Seconds $Seconds }
    'manual' { Start-Sleep -Seconds $Seconds }
    'scroll' {
      while ((Get-Date) -lt $end) {
        Sh "input swipe $x $yHigh $x $yLow 700" | Out-Null
        Sh "input swipe $x $yLow $x $yHigh 700" | Out-Null
      }
    }
    'fling' {
      while ((Get-Date) -lt $end) {
        Sh "input swipe $x $yHigh $x $yLow 90" | Out-Null
        Start-Sleep -Milliseconds 900
        Sh "input swipe $x $yLow $x $yHigh 90" | Out-Null
        Start-Sleep -Milliseconds 900
      }
    }
    'drawer' {
      while ((Get-Date) -lt $end) {
        Sh "input swipe 4 $yMid $xFar $yMid 300" | Out-Null
        Start-Sleep -Milliseconds 700
        Sh "input swipe $xFar $yMid 4 $yMid 300" | Out-Null
        Start-Sleep -Milliseconds 700
      }
    }
  }
  (Sh "dumpsys gfxinfo $Package") | Set-Content -Encoding ascii (Join-Path $out "run$i.txt")
}
(Sh "dumpsys meminfo $Package" | Select-Object -First 45) | Set-Content -Encoding ascii (Join-Path $out 'meminfo.txt')

$nodeArgs = @((Join-Path $repo 'scripts\perf\gfxinfo.mjs'), '--check')
for ($i = 1; $i -le $Runs; $i++) { $nodeArgs += '--file'; $nodeArgs += (Join-Path $out "run$i.txt") }
$json = & node @nodeArgs
$code = $LASTEXITCODE
$json | Set-Content -Encoding ascii (Join-Path $repo "docs\perf\$Label-$Scenario.json")
if ($code -eq 0) { Write-Host "PASS  $Label $Scenario" } else { Write-Host "FAIL  $Label $Scenario (see docs\perf\$Label-$Scenario.json)" }
Sh "am force-stop $Package" | Out-Null
exit $code
