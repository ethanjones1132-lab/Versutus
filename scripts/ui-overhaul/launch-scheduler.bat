@echo off
REM Schedules PR4-PR8 at 30-minute intervals (first run in 30 min).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0schedule-jobs.ps1" -IntervalMinutes 30 -InitialDelayMinutes 30 -PrNumberList "4,5,6,7,8"