# Versutus Optimization Loop — Scheduling

Recurring Grok headless runs every **30 minutes** to optimize Android native UI (3 passes), then implement high-impact roadmap features.

## Phases

| Pass | Phase | Prompt file | Focus |
|------|-------|-------------|-------|
| 1 | android-ui | `prompt-android-pass-1.txt` | Foundation — onboarding/home Android elevation |
| 2 | android-ui | `prompt-android-pass-2.txt` | Interactions — chat/terminal Android, haptics, motion |
| 3 | android-ui | `prompt-android-pass-3.txt` | Final polish — settings/add, audit, unlock features |
| 4+ | features | `prompt-features.txt` | One backlog feature per pass from `features-backlog.json` |

**Status:** `status.json`  
**Feature backlog:** `features-backlog.json`  
**Logs:** `logs/`

## Rules (from ui-overhaul scheduler)

1. **Never use `--continue`** — each prompt is self-contained.
2. **Use full grok path:** `C:\Users\ethan\.grok\bin\grok.exe`
3. **Invocation:**
   ```powershell
   grok --prompt-file "...\prompt-android-pass-1.txt" --cwd "C:\Users\ethan\Versutus" --yolo --output-format plain
   ```
4. **Grok must be authenticated** (`grok auth`) before headless runs work.
5. Each run updates `status.json` when complete (prompt instructs the agent).

## Start the loop

```bat
C:\Users\ethan\Versutus\scripts\optimization-loop\launch-loop.bat
```

Or with PowerShell (custom interval):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File "C:\Users\ethan\Versutus\scripts\optimization-loop\schedule-loop.ps1" `
  -IntervalMinutes 30 `
  -InitialDelayMinutes 0
```

## Stop the loop

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File "C:\Users\ethan\Versutus\scripts\optimization-loop\stop-loop.ps1"
```

## Manual one-off run

```powershell
# Android pass 1 only
& "C:\Users\ethan\.grok\bin\grok.exe" `
  --prompt-file "C:\Users\ethan\Versutus\scripts\optimization-loop\prompt-android-pass-1.txt" `
  --cwd "C:\Users\ethan\Versutus" `
  --yolo --output-format plain

# Single scheduler iteration (no repeat)
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File "...\schedule-loop.ps1" -RunOnce
```

## Monitor

```powershell
Get-Content "C:\Users\ethan\Versutus\scripts\optimization-loop\status.json" | ConvertFrom-Json
Get-ChildItem "C:\Users\ethan\Versutus\scripts\optimization-loop\logs" | Sort-Object LastWriteTime -Descending | Select-Object -First 5
```