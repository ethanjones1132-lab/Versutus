# Versutus UI Overhaul — staggered PR scheduler
# Runs grok headless for each PR (no --continue; each prompt is self-contained).

param(
    [int]$IntervalMinutes = 30,
    [string]$PrNumberList = "4,5,6,7,8",
    [int]$InitialDelayMinutes = 30,
    [string]$ProjectRoot = "C:\Users\ethan\Versutus",
    [string]$LogDir = "C:\Users\ethan\Versutus\scripts\ui-overhaul\logs",
    [string]$GrokExe = "C:\Users\ethan\.grok\bin\grok.exe"
)

$ErrorActionPreference = "Continue"
$PrNumbers = $PrNumberList.Split(',') | ForEach-Object { [int]$_.Trim() }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (-not (Test-Path $GrokExe)) {
    $GrokExe = "grok"
}

$startTime = Get-Date
$scheduleFile = Join-Path $ProjectRoot "scripts\ui-overhaul\schedule-manifest.json"

$manifest = @{
    createdAt = $startTime.ToString("o")
    intervalMinutes = $IntervalMinutes
    initialDelayMinutes = $InitialDelayMinutes
    prNumbers = $PrNumbers
    grokCommand = "$GrokExe --prompt-file <prompt> --cwd $ProjectRoot --yolo --output-format plain"
    jobs = @()
}

foreach ($i in 0..($PrNumbers.Length - 1)) {
    $pr = $PrNumbers[$i]
    $delayMinutes = $InitialDelayMinutes + ($IntervalMinutes * $i)
    $fireAt = $startTime.AddMinutes($delayMinutes)
    $manifest.jobs += @{
        pr = "PR$pr"
        promptFile = "pr$pr-prompt.txt"
        scheduledAt = $fireAt.ToString("o")
        delayMinutes = $delayMinutes
    }
}

$manifest | ConvertTo-Json -Depth 4 | Set-Content -Path $scheduleFile -Encoding UTF8
Write-Host "Schedule manifest written to $scheduleFile"
$manifest.jobs | ForEach-Object { Write-Host "  $($_.pr) at $($_.scheduledAt) (+$($_.delayMinutes)m)" }

foreach ($i in 0..($PrNumbers.Length - 1)) {
    $pr = $PrNumbers[$i]
    $delayMinutes = $InitialDelayMinutes + ($IntervalMinutes * $i)
    $promptFile = Join-Path $ProjectRoot "scripts\ui-overhaul\pr$pr-prompt.txt"
    $logFile = Join-Path $LogDir "pr$pr-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"

    if ($delayMinutes -gt 0) {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Waiting $delayMinutes minutes before PR$pr..."
        Start-Sleep -Seconds ($delayMinutes * 60)
    }

    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Starting PR$pr..."
    Write-Host "  Grok: $GrokExe"
    Write-Host "  Prompt: $promptFile"
    Write-Host "  Log: $logFile"

    $exitCode = 0
    try {
        & $GrokExe --prompt-file $promptFile --cwd $ProjectRoot --yolo --output-format plain 2>&1 |
            Tee-Object -FilePath $logFile
        $exitCode = $LASTEXITCODE
        if ($exitCode -eq 0) {
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] PR$pr finished successfully."
        } else {
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] PR$pr exited with code $exitCode" -ForegroundColor Red
        }
    } catch {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] PR$pr FAILED: $_" -ForegroundColor Red
        $_ | Out-File -FilePath $logFile -Append
    }
}

Write-Host "[$(Get-Date -Format 'HH:mm:ss')] All scheduled PR jobs complete."