[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z][a-z0-9-]{4,29}$')][string]$ProjectId,
  [Parameter(Mandatory = $true)]
  [ValidateSet(
    'classify-backfill', 'refresh-canary', 'refresh-backfill', 'verify-backfill', 'retry-failed',
    'nutrition-canary', 'nutrition-backfill', 'verify-nutrition'
  )]
  [string]$Mode,
  [string]$Region = 'europe-west1',
  [string]$JobName = 'mealwizard-catalogue-ingestion',
  [string]$SchedulerName = 'mealwizard-catalogue-daily',
  [ValidateRange(0, 18000)][int]$WriteCap = 8000,
  [ValidateRange(0, 500)][int]$GeminiCallCap = 500,
  [ValidateRange(1, 250)][int]$MaxPerSource = 250
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'gcloudResourceProbe.ps1')
$runId = "phase4-$Mode-$([DateTimeOffset]::UtcNow.ToString('yyyyMMddHHmmss'))"

function Get-SafetyMode {
  $state = gcloud scheduler jobs describe $SchedulerName --location=$Region --project=$ProjectId --format='value(state)'
  if ($state -ne 'PAUSED') { throw "Scheduler must be PAUSED; observed $state" }
  $mode = node scripts/readCatalogueGenerationMode.mjs --project $ProjectId
  if ($LASTEXITCODE -ne 0) { throw 'Could not read catalogue generation mode' }
  return ([string]$mode).Trim()
}

$initialMode = Get-SafetyMode
try {
  $jobArgs = @($Mode, '--run-id', $runId)
  if ($Mode -in @('classify-backfill', 'refresh-backfill', 'retry-failed')) {
    $jobArgs += @('--write-cap', [string]$WriteCap)
    # gcloud list flags reject duplicate string elements. Use an equivalent
    # numeric spelling when both caps are equal; Number("+25") remains 25.
    $geminiCapArgument = if ($GeminiCallCap -eq $WriteCap) {
      "+$GeminiCallCap"
    } else {
      [string]$GeminiCallCap
    }
    $jobArgs += @('--gemini-call-cap', $geminiCapArgument)
  }
  if ($Mode -eq 'nutrition-backfill') {
    $jobArgs += @(
      '--write-cap', [string]$WriteCap,
      '--max-per-source', [string]$MaxPerSource
    )
  }
  if ($Mode -eq 'refresh-backfill') {
    $jobArgs += @('--max-per-source', [string]$MaxPerSource)
  }
  # Use gcloud's alternate list delimiter to preserve argument boundaries.
  $encodedArgs = '^|^' + ($jobArgs -join '|')
  gcloud run jobs execute $JobName `
    --region=$Region `
    --project=$ProjectId `
    --args=$encodedArgs `
    --wait
} finally {
  $finalMode = Get-SafetyMode
  if ($finalMode -ne $initialMode) {
    throw "Generation mode changed during Phase 4 command: $initialMode -> $finalMode"
  }
}
