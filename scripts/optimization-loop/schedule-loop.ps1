# Versutus Optimization Loop - recurring 30-minute scheduler
# Passes 1-3: Android native UI optimization
# Pass 4+: High-impact roadmap features from features-backlog.json

param(
    [int]$IntervalMinutes = 30,
    [int]$InitialDelayMinutes = 0,
    [string]$ProjectRoot = "C:\Users\ethan\Versutus",
    [string]$LoopDir = "C:\Users\ethan\Versutus\scripts\optimization-loop",
    [string]$GrokExe = "C:\Users\ethan\.grok\bin\grok.exe",
    [switch]$RunOnce
)

$ErrorActionPreference = "Continue"
$LogDir = Join-Path $LoopDir "logs"
$StatusFile = Join-Path $LoopDir "status.json"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (-not (Test-Path $GrokExe)) {
    $GrokExe = "grok"
}

function Read-Status {
    if (-not (Test-Path $StatusFile)) {
        throw "Missing status file: $StatusFile"
    }
    return Get-Content -Path $StatusFile -Raw | ConvertFrom-Json
}

function Resolve-PromptFile {
    param($Status)

    if ($Status.phase -eq "features" -and $Status.featurePhase.status -eq "active") {
        return Join-Path $LoopDir "prompt-features.txt"
    }

    $pass = [int]$Status.currentPass
    if ($pass -le 1) { return Join-Path $LoopDir "prompt-android-pass-1.txt" }
    if ($pass -eq 2) { return Join-Path $LoopDir "prompt-android-pass-2.txt" }
    if ($pass -eq 3) { return Join-Path $LoopDir "prompt-android-pass-3.txt" }
    return Join-Path $LoopDir "prompt-features.txt"
}

function Get-RunLabel {
    param($Status)
    if ($Status.phase -eq "features") {
        $fid = $Status.featurePhase.currentFeatureId
        if ($fid) { return "Feature-$fid" }
        return "Feature-next"
    }
    return "AndroidUI-Pass$($Status.currentPass)"
}

function Write-LogLine {
    param([string]$Message)
    $stamp = Get-Date -Format "HH:mm:ss"
    Write-Host "[$stamp] $Message"
}

$startTime = Get-Date
Write-Host "=============================================="
Write-Host " Versutus Optimization Loop Scheduler"
Write-Host " Started: $($startTime.ToString('yyyy-MM-dd HH:mm:ss'))"
Write-Host " Interval: $IntervalMinutes minutes"
Write-Host " Initial delay: $InitialDelayMinutes minutes"
Write-Host " Run once: $RunOnce"
Write-Host " Status: $StatusFile"
Write-Host " Logs: $LogDir"
Write-Host "=============================================="

if ($InitialDelayMinutes -gt 0) {
    Write-LogLine "Waiting $InitialDelayMinutes minutes before first run..."
    Start-Sleep -Seconds ($InitialDelayMinutes * 60)
}

$runIndex = 0
do {
    $runIndex++
    $status = Read-Status
    $label = Get-RunLabel -Status $status
    $promptFile = Resolve-PromptFile -Status $status
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $logFile = Join-Path $LogDir "$label-$timestamp.log"

    Write-Host ""
    Write-LogLine "Run $runIndex - $label"
    Write-Host "  Phase: $($status.phase) | Pass: $($status.currentPass)"
    Write-Host "  Prompt: $promptFile"
    Write-Host "  Log: $logFile"

    if (-not (Test-Path $promptFile)) {
        Write-Host "  ERROR: Prompt file missing. Skipping run." -ForegroundColor Red
    } else {
        $exitCode = 0
        try {
            & $GrokExe --prompt-file $promptFile --cwd $ProjectRoot --yolo --output-format plain 2>&1 |
                Tee-Object -FilePath $logFile
            $exitCode = $LASTEXITCODE
            if ($exitCode -eq 0) {
                Write-LogLine "Run $runIndex finished successfully."
            } else {
                Write-LogLine "Run $runIndex exited with code $exitCode"
            }
        } catch {
            Write-LogLine "Run $runIndex FAILED: $_"
            $_ | Out-File -FilePath $logFile -Append
            $exitCode = 1
        }
    }

    if ($RunOnce) {
        Write-LogLine "RunOnce set - exiting."
        break
    }

    Write-LogLine "Next run in $IntervalMinutes minutes..."
    Start-Sleep -Seconds ($IntervalMinutes * 60)
} while ($true)

Write-LogLine "Scheduler stopped."