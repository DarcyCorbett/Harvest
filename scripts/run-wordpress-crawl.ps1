[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z][a-z0-9-]{4,29}$')][string]$ProjectId,
  [Parameter(Mandatory = $true)]
  [ValidateSet(
    'crawl-canary', 'crawl-inventory', 'crawl-backfill',
    'snapshot-inventory', 'snapshot-canary', 'snapshot-crawl', 'snapshot-verify',
    'tag-batch-prepare', 'tag-batch-submit', 'tag-batch-collect', 'weekly-new'
  )]
  [string]$Mode,
  [string]$Region = 'europe-west1',
  [string]$JobName = 'mealwizard-catalogue-ingestion',
  [string]$SchedulerName = 'mealwizard-catalogue-daily',
  [ValidateRange(0, 18000)][int]$WriteCap = 18000,
  [ValidateRange(1, 10000)][int]$MaxPerSource = 500,
  [string[]]$SourceKeys,
  [switch]$ConfirmPaidBatch
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'gcloudResourceProbe.ps1')

$allowedSources = @(
  'recipetineats',
  'budgetbytes',
  'thewoksoflife',
  'themediterraneandish',
  'spendwithpennies',
  'cafedelites',
  'skinnytaste',
  'pinchofyum',
  'natashaskitchen',
  'nytcooking',
  'americastestkitchen'
)
if ($SourceKeys) {
  $invalidSources = @($SourceKeys | Where-Object { $_ -notin $allowedSources })
  if ($invalidSources.Count -gt 0) {
    throw "Unsupported catalogue source: $($invalidSources -join ', ')"
  }
}
if ($Mode -eq 'tag-batch-submit' -and -not $ConfirmPaidBatch) {
  throw 'Tag batch submission requires -ConfirmPaidBatch after reviewing prepare-mode cost.'
}

$runId = "wordpress-$Mode-$([DateTimeOffset]::UtcNow.ToString('yyyyMMddHHmmss'))"

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
  if ($SourceKeys) {
    $jobArgs += @('--source', ($SourceKeys -join ','))
  }
  if ($Mode -in @('crawl-backfill', 'snapshot-crawl', 'weekly-new')) {
    $jobArgs += @(
      '--write-cap', [string]$WriteCap,
      '--max-per-source', [string]$MaxPerSource
    )
  }
  if ($Mode -eq 'tag-batch-submit') {
    $jobArgs += '--confirm-paid-batch'
  }
  $encodedArgs = '^|^' + ($jobArgs -join '|')
  gcloud run jobs execute $JobName `
    --region=$Region `
    --project=$ProjectId `
    --args=$encodedArgs `
    --wait
  if ($LASTEXITCODE -ne 0) {
    throw "Cloud Run catalogue execution failed with exit code $LASTEXITCODE"
  }
} finally {
  $finalMode = Get-SafetyMode
  if ($finalMode -ne $initialMode) {
    throw "Generation mode changed during WordPress crawl: $initialMode -> $finalMode"
  }
}
