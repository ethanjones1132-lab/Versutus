@echo off
REM Versutus Optimization Loop — 30 min interval, starts immediately
REM Passes 1-3: Android UI | Pass 4+: roadmap features
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0schedule-loop.ps1" -IntervalMinutes 30 -InitialDelayMinutes 0