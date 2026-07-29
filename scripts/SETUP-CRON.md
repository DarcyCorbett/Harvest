# Daily Recipe Index Scrape — Setup

Sets up a Windows scheduled task that runs the recipe index Phase A scraper daily, rotating through the three active indexed sites by day-of-week. After this is installed, no further manual intervention is needed — the index stays fresh automatically.

## Site rotation

| Day | Site |
|---|---|
| Mon | akispetretzikis.com |
| Tue | www.americastestkitchen.com |
| Wed | rest day |
| Thu | cooking.nytimes.com |
| Fri / Sat / Sun | rest day (no scrape) |

The scrape runs at **03:00 local time**. Each run is capped at 18,000 new writes to leave headroom under the Firestore Spark-tier 20K writes/day quota.

## Prerequisites

- `service-account.json` in the project root (already in place — see [buildRecipeIndex.ts](buildRecipeIndex.ts) header for the original setup steps).
- `firebase-admin` and `playwright` dev dependencies installed (already in place).
- `npx tsx scripts/buildRecipeIndex.ts --site <domain>` works from a regular shell.

## Install

Open **PowerShell as Administrator**, cd to the project root, then:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-cron.ps1
```

The installer registers a task named `MealWizard Recipe Index Daily` to run as your user with Interactive logon. No password prompt — the task fires at 03:00 whenever you're logged in (including when the screen is locked). If your laptop is logged off entirely at 03:00, that day's run is skipped (next week's rotation catches up).

## Verify

Trigger the task manually right after install:

```powershell
Start-ScheduledTask -TaskName 'MealWizard Recipe Index Daily'
```

Within a few seconds a log file appears under `scripts/logs/recipe-index-<site>-<timestamp>.log`. Tail it:

```powershell
Get-ChildItem scripts/logs -Filter 'recipe-index-*.log' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 |
  Get-Content -Wait -Tail 50
```

Open the Task Scheduler GUI (`taskschd.msc`) → Task Scheduler Library → find `MealWizard Recipe Index Daily`. The "Last Run Result" column should read `0x0` (success) once the run completes.

### Test on a rest day

If today is Fri / Sat / Sun the wrapper will exit immediately with `[CRON] ISO day-of-week N is a rest day`. To run the wrapper anyway for testing, override the site:

```powershell
$env:RECIPE_INDEX_FORCE_SITE = 'akispetretzikis.com'
powershell -NoProfile -File scripts/run-daily-crawl.ps1
```

## Wake from sleep

The task is registered with `-WakeToRun`, so Windows wakes the machine from sleep / hibernate at 03:00 to fire the task. This requires Windows' "Allow wake timers" power setting to be enabled — the install script checks this and prints either confirmation or instructions to enable it.

To enable manually if needed:

```powershell
powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_SLEEP RTCWAKE 1
powercfg /SETDCVALUEINDEX SCHEME_CURRENT SUB_SLEEP RTCWAKE 1
powercfg /SETACTIVE SCHEME_CURRENT
```

(AC = plugged in, DC = battery. Disable DC if you don't want the laptop waking on battery.)

## Catch-up after machine-off nights

If the machine was fully powered off at 03:00 (not just sleeping), `-StartWhenAvailable` runs the task next time the machine is on. You'll see a one-day-late entry in the run history but the rotation continues normally — only the missed day's site is skipped (next week's rotation picks it up).

## Uninstall

```powershell
Unregister-ScheduledTask -TaskName 'MealWizard Recipe Index Daily' -Confirm:$false
```

## Logs

- Location: `scripts/logs/` (gitignored)
- Filename: `recipe-index-<site>-<yyyy-MM-dd-HHmmss>.log`
- Auto-pruned: files older than 30 days are deleted at the end of each run

## Troubleshooting

- **"Last Run Result" shows a non-zero code**: open the most recent log in `scripts/logs/`. Common causes:
  - HTTP 402/403 with no successful Playwright fallback → site temporarily blocking; will retry next week.
  - Firestore quota exhausted → the script logs `Firestore quota exhausted. Wrote N new + M refreshed before stopping.` and exits 0; another `0x0` run next week will continue.
  - Network down → the wrapper's `RunOnlyIfNetworkAvailable` flag should normally prevent this, but may slip during startup.
- **Task didn't run at all**: confirm the machine wasn't sleeping/hibernating at 03:00. `-StartWhenAvailable` only catches up on next wake; if you sleep for several days the task may quietly skip.
- **"No account credentials" / "user name or password is incorrect" during install**: re-run the install script — sometimes the elevated session loses cached creds. Make sure you're in an Administrator PowerShell window (Windows key → type "PowerShell" → right-click → Run as administrator), then `cd` to the project root before running the install command.
