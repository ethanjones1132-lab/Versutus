# Stop any running optimization-loop or ui-overhaul schedulers
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object {
        $_.CommandLine -like '*optimization-loop*schedule-loop*' -or
        $_.CommandLine -like '*ui-overhaul*schedule-jobs*'
    } |
    ForEach-Object {
        Write-Host "Stopping PID $($_.ProcessId): $($_.CommandLine)"
        Stop-Process -Id $_.ProcessId -Force
    }
Write-Host "Done."