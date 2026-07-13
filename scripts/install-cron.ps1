# ============================================================
# One-shot installer: registers the daily recipe-index scrape with
# Windows Task Scheduler. Run ONCE as Administrator.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-cron.ps1
#
# After install, the task runs daily at 03:00 local. To trigger manually
# (for verification): open Task Scheduler GUI, find "MealWizard Recipe
# Index Daily", right-click -> Run.
#
# To uninstall:
#   Unregister-ScheduledTask -TaskName 'MealWizard Recipe Index Daily' -Confirm:$false
# ============================================================

$ErrorActionPreference = 'Stop'

$TaskName = 'MealWizard Recipe Index Daily'

# Refuse to run without admin (Task Scheduler registration needs it).
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($currentUser)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
  Write-Error "This script must be run as Administrator. Right-click PowerShell -> 'Run as administrator', then re-run."
  exit 1
}

# Resolve the wrapper script's absolute path so the registered action
# survives Task Scheduler running from a system folder later.
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WrapperPath = Join-Path $ProjectRoot 'scripts/run-daily-crawl.ps1'
if (-not (Test-Path $WrapperPath)) {
  Write-Error "Wrapper not found at $WrapperPath. Make sure you're running this from the project repo."
  exit 1
}

# Define the task.
$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$WrapperPath`"" `
  -WorkingDirectory $ProjectRoot

$trigger = New-ScheduledTaskTrigger -Daily -At '03:00'

# WakeToRun: bring the machine out of sleep/hibernate at 03:00 so the
# task fires on schedule. NB: this only works if Windows' power plan
# has "Allow wake timers" enabled — checked below after the task is
# registered.
# StartWhenAvailable: catch up missed runs after the machine wakes
# from sleep / was powered off at 03:00.
# RunOnlyIfNetworkAvailable: skip the run if there's no network rather
# than burning retries.
# ExecutionTimeLimit: hard cap so a hung run doesn't sit forever.
$settings = New-ScheduledTaskSettingsSet `
  -WakeToRun `
  -StartWhenAvailable `
  -RunOnlyIfNetworkAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -MultipleInstances IgnoreNew

# Run as the current user with Interactive logon. Pros: no password
# required at install time, task runs whenever you're logged in
# (including when the screen is locked — that's still an active
# interactive session). Cons: task is skipped on days when nobody is
# logged in. For the always-on developer machine this is fine.
#
# If you ever need the task to run when logged-off, change LogonType
# to Password and pass `-User`/`-Password` to Register-ScheduledTask.
# S4U is unsuitable here — it blocks network access, which we need for
# sitemap fetches.
$principalForTask = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited

# Remove any existing task with the same name so re-running this script
# is idempotent.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "[INSTALL] Removing existing task '$TaskName'..."
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Write-Host "[INSTALL] Registering task '$TaskName'..."
Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principalForTask `
  -Description 'Daily Phase A scrape of the recipe discovery index. Rotates indexed sites by day-of-week.' | Out-Null

Write-Host ""
Write-Host "[INSTALL] Done. Task '$TaskName' will run daily at 03:00 local time."

# Verify the OS-level "Allow wake timers" power setting. WakeToRun on the
# task is necessary but not sufficient -- Windows' power plan must also
# permit wake timers, or the machine will sleep through the schedule.
# The setting GUID is bd3b718a-0680-4d9d-8ab2-e1d2b4ac806d. powercfg
# returns hex values per power state (AC, DC). 0x000 = Disable,
# 0x001 = Enable, 0x002 = Important Wake Timers Only (Win10+).
try {
  $rtc = & powercfg /q SCHEME_CURRENT SUB_SLEEP bd3b718a-0680-4d9d-8ab2-e1d2b4ac806d 2>$null
  $acVal = ($rtc | Select-String 'Current AC Power Setting Index:').Line
  $dcVal = ($rtc | Select-String 'Current DC Power Setting Index:').Line
  $acDisabled = $acVal -match '0x00000000'
  $dcDisabled = $dcVal -match '0x00000000'
  if ($acDisabled -or $dcDisabled) {
    Write-Host ""
    Write-Host "[INSTALL] WARNING: 'Allow wake timers' is disabled in your power plan." -ForegroundColor Yellow
    if ($acDisabled) { Write-Host "[INSTALL]   AC (plugged-in): DISABLED" -ForegroundColor Yellow }
    if ($dcDisabled) { Write-Host "[INSTALL]   DC (battery):    DISABLED" -ForegroundColor Yellow }
    Write-Host "[INSTALL] Without this, the machine won't wake from sleep at 03:00."
    Write-Host "[INSTALL] To enable (run from any PowerShell):"
    Write-Host "          powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_SLEEP RTCWAKE 1"
    Write-Host "          powercfg /SETDCVALUEINDEX SCHEME_CURRENT SUB_SLEEP RTCWAKE 1"
    Write-Host "          powercfg /SETACTIVE SCHEME_CURRENT"
  } else {
    Write-Host "[INSTALL] 'Allow wake timers' is enabled - machine will wake at 03:00 if asleep."
  }
} catch {
  Write-Host "[INSTALL] (Could not verify wake-timer power setting: $_)"
}

Write-Host ""
Write-Host "[INSTALL] To trigger manually for verification:"
Write-Host "          Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "[INSTALL] To uninstall:"
Write-Host "          Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
