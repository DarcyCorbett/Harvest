# ============================================================
# Daily wrapper for the recipe index scrape + tag pipeline.
#
# Phase A — URL discovery (buildRecipeIndex.ts):
#   Picks one of the 2 active indexed sites by ISO day-of-week, runs
#   scripts/buildRecipeIndex.ts with a per-run write cap.
#
# Phase B — Gemini tagging (tagRecipeIndex.ts):
#   Runs EVERY day (including rest days) across ALL indexed sites
#   to tag untagged recipes discovered by Phase A.
#
# Day rotation (Phase A only):
#   Mon -> rest day
#   Tue -> www.americastestkitchen.com
#   Wed -> rest day
#   Thu -> cooking.nytimes.com
#   Fri/Sat/Sun -> rest day (Phase A skipped, Phase B still runs)
#
# Why rotation: per-site existing-set reads can approach the 50K/day Firestore
# Spark read quota. Spreading the work across the week keeps each day under
# quota with comfortable headroom for the app's normal usage.
#
# Override for testing: set $env:RECIPE_INDEX_FORCE_SITE before invoking.
#   $env:RECIPE_INDEX_FORCE_SITE = 'cooking.nytimes.com'
#   pwsh -File scripts/run-daily-crawl.ps1
# ============================================================

$ErrorActionPreference = 'Continue'

# Resolve project root (the script lives in <root>/scripts/).
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

# This scheduled tagger is a temporary Phase 0 bridge. It uses the same local
# service-account identity for Firestore and Secret Manager via ADC. Task 10
# verifies that this identity has secretAccessor on only the Gemini secret.
$ServiceAccountPath = Join-Path $ProjectRoot 'service-account.json'
if (-not (Test-Path -LiteralPath $ServiceAccountPath)) {
  throw "service-account.json is required for Firestore and Secret Manager access."
}
$env:GOOGLE_APPLICATION_CREDENTIALS = $ServiceAccountPath
$env:GOOGLE_CLOUD_PROJECT = 'meal-wizard-ad202'

# Conservative daily allocation: 12,000 discovery + 4,000 tag/cache = 16,000
# worst-case writes. This leaves at least 2,000 writes below the approved
# 18,000 ingestion ceiling. The tagger visits two sites and performs at most
# two writes per newly cached recipe (500 x 2 x 2). An already-cached recipe
# consumes only the one index-marker write and is never rewritten.
$DailyWriteCeiling = 18000
$DiscoveryWriteLimit = 12000
$TagLimitPerSite = 500

# Pick site. Force-override env var for manual testing wins; otherwise
# rotate by ISO day-of-week (1=Mon..7=Sun).
$isRestDay = $false
$site = $env:RECIPE_INDEX_FORCE_SITE
if (-not $site) {
  # PowerShell DayOfWeek enum: Sunday=0..Saturday=6. Map to ISO 1..7.
  $dotnetDow = [int](Get-Date).DayOfWeek
  $isoDow = if ($dotnetDow -eq 0) { 7 } else { $dotnetDow }

  switch ($isoDow) {
    2 { $site = 'www.americastestkitchen.com' }
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
Write-Host "[CRON] Discovery limit: $DiscoveryWriteLimit new writes"
Write-Host "[CRON] Tag limit:       $TagLimitPerSite recipes/site"
Write-Host "[CRON] Log:     $LogFile"
Write-Host "[CRON] Started: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

$exitCode = 0

if (-not $isRestDay) {
  # Run the scraper. Tee-Object captures both stdout and stderr (via *>&1)
  # into the log while still echoing to the console.
  & npx -y tsx scripts/buildRecipeIndex.ts --site $site --limit $DiscoveryWriteLimit *>&1 |
    Tee-Object -FilePath $LogFile
  $exitCode = $LASTEXITCODE
} else {
  Write-Host "[CRON] Rest day - skipping scrape phase." *>&1 | Tee-Object -FilePath $LogFile
}

Write-Host "[CRON] === MealWizard Recipe Tagger ===" *>&1 | Tee-Object -FilePath $LogFile -Append
Write-Host "[CRON] Started: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" *>&1 | Tee-Object -FilePath $LogFile -Append

& npx -y tsx scripts/tagRecipeIndex.ts --limit $TagLimitPerSite *>&1 |
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
