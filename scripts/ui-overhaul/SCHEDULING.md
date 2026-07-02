# Versutus UI Overhaul — Scheduling PRs with Grok Headless

## Rules (learned the hard way)

1. **Never use `--continue`** in headless scheduled runs. It requires an active interactive session in that directory and fails with:
   `Error: No session found for current directory`

2. **Use self-contained prompt files** (`prN-prompt.txt`). Each prompt must include full context: read `status.json`, read the plan, verify prior PRs, implement to completion, update `status.json`.

3. **Pass PR numbers as a string**, not a bare comma list from `.bat` files:
   ```bat
   -PrNumberList "4,5,6,7,8"
   ```
   Without quotes, PowerShell parses `4,5,6,7,8` as the single integer `45678`.

4. **Use the full grok path** when possible:
   `C:\Users\ethan\.grok\bin\grok.exe`

5. **Correct headless invocation:**
   ```powershell
   grok --prompt-file "C:\Users\ethan\Versutus\scripts\ui-overhaul\pr4-prompt.txt" `
        --cwd "C:\Users\ethan\Versutus" `
        --yolo `
        --output-format plain
   ```

6. **Launch via batch** (avoids shell-wrapper `(cd ; cmd)` parser errors):
   ```bat
   C:\Users\ethan\Versutus\scripts\ui-overhaul\launch-scheduler.bat
   ```

7. **Stagger timing** is handled in `schedule-jobs.ps1`:
   - `InitialDelayMinutes` — wait before first PR
   - `IntervalMinutes` — gap between subsequent PRs
   - Formula: delay for PR at index `i` = `InitialDelayMinutes + IntervalMinutes * i`

8. **Kill a running scheduler:**
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
     Where-Object { $_.CommandLine -like '*schedule-jobs.ps1*' } |
     ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
   ```

9. **Logs** land in `scripts/ui-overhaul/logs/`. **Status** tracked in `scripts/ui-overhaul/status.json`.

10. **Grok must be authenticated** (`grok auth`) before headless runs will work.

## Manual one-off run

```powershell
& "C:\Users\ethan\.grok\bin\grok.exe" `
  --prompt-file "C:\Users\ethan\Versutus\scripts\ui-overhaul\pr4-prompt.txt" `
  --cwd "C:\Users\ethan\Versutus" `
  --yolo `
  --output-format plain
```

## Schedule PR4–8 (30 min apart, first in 30 min)

Edit `launch-scheduler.bat` or run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File "C:\Users\ethan\Versutus\scripts\ui-overhaul\schedule-jobs.ps1" `
  -IntervalMinutes 30 `
  -InitialDelayMinutes 30 `
  -PrNumberList "4,5,6,7,8"
```