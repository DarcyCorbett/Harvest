# ============================================================
# Daily wrapper for the recipe index scrape + tag pipeline.
#
# Phase A — URL discovery (buildRecipeIndex.ts):
#   Picks one of the 4 indexed sites by ISO day-of-week, runs
#   scripts/buildRecipeIndex.ts with a per-run write cap.
#
# Phase B — Gemini tagging (tagRecipeIndex.ts):
#   Runs EVERY day (including rest days) across ALL indexed sites
#   to tag untagged recipes discovered by Phase A.
#
# Day rotation (Phase A only):
#   Mon -> akispetretzikis.com
#   Tue -> www.americastestkitchen.com
#   Wed -> www.seriouseats.com
#   Thu -> cooking.nytimes.com
#   Fri/Sat/Sun -> rest day (Phase A skipped, Phase B still runs)
#
# Why rotation: per-site existing-set reads sum to ~70K/day across all
# four sites after full population, exceeding the 50K/day Firestore Spark
# read quota. Spreading the work across the week keeps each day under
# quota with comfortable headroom for the app's normal usage.
#
# Override for testing: set $env:RECIPE_INDEX_FORCE_SITE before invoking.
#   $env:RECIPE_INDEX_FORCE_SITE = 'akispetretzikis.com'
#   pwsh -File scripts/run-daily-crawl.ps1
# ============================================================

$ErrorActionPreference = 'Continue'

# Resolve project root (the script lives in <root>/scripts/).
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

# Per-run write cap. Spark tier free quota = 20K writes/day total. Reserve
# 2K headroom for app-side writes (recipe cache, meal plans, etc).
$WriteLimit = 18000

# Pick site. Force-override env var for manual testing wins; otherwise
# rotate by ISO day-of-week (1=Mon..7=Sun).
$isRestDay = $false
$site = $env:RECIPE_INDEX_FORCE_SITE
if (-not $site) {
  # PowerShell DayOfWeek enum: Sunday=0..Saturday=6. Map to ISO 1..7.
  $dotnetDow = [int](Get-Date).DayOfWeek
  $isoDow = if ($dotnetDow -eq 0) { 7 } else { $dotnetDow }

  switch ($isoDow) {
    1 { $site = 'akispetretzikis.com' }
    2 { $site = 'www.americastestkitchen.com' }
    3 { $site = 'www.seriouseats.com' }
    4 { $site = 'cooking.nytimes.com' }
    default {
      $isRestDay = $true
      $site = 'rest-day'
    }
  }
}

# Ensure logs directory exists.
$LogDir = Join-Path $ProjectRoot 'scripts/logs'
if (-not (Test-Path $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir | Out-Null
}

$timestamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
$LogFile = Join-Path $LogDir "recipe-index-$site-$timestamp.log"

Write-Host "[CRON] === MealWizard Recipe Index Daily Crawl ==="
Write-Host "[CRON] Project: $ProjectRoot"
Write-Host "[CRON] Site:    $site"
Write-Host "[CRON] Limit:   $WriteLimit new writes"
Write-Host "[CRON] Log:     $LogFile"
Write-Host "[CRON] Started: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

$exitCode = 0

if (-not $isRestDay) {
  # Run the scraper. Tee-Object captures both stdout and stderr (via *>&1)
  # into the log while still echoing to the console.
  & npx -y tsx scripts/buildRecipeIndex.ts --site $site --limit $WriteLimit *>&1 |
    Tee-Object -FilePath $LogFile
  $exitCode = $LASTEXITCODE
} else {
  Write-Host "[CRON] Rest day - skipping scrape phase." *>&1 | Tee-Object -FilePath $LogFile
}

Write-Host "[CRON] === MealWizard Recipe Tagger ===" *>&1 | Tee-Object -FilePath $LogFile -Append
Write-Host "[CRON] Started: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" *>&1 | Tee-Object -FilePath $LogFile -Append

& npx -y tsx scripts/tagRecipeIndex.ts --limit 500 *>&1 |
  Tee-Object -FilePath $LogFile -Append

if ($LASTEXITCODE -ne 0) {
  $exitCode = $LASTEXITCODE
}

Write-Host "[CRON] Finished: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') (exit=$exitCode)" *>&1 | Tee-Object -FilePath $LogFile -Append

# Prune old logs (>30 days). Defensive: ignore errors if a log is in use.
try {
  Get-ChildItem $LogDir -File -Filter 'recipe-index-*.log' |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
    Remove-Item -Force -ErrorAction SilentlyContinue
} catch {
  Write-Host "[CRON] Log pruning skipped: $_"
}

# Propagate the scraper's exit code so Task Scheduler "Last Run Result"
# reflects success/failure accurately.
exit $exitCode
