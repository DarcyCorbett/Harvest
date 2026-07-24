[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z][a-z0-9-]{4,29}$')][string]$ProjectId,
  [Parameter(Mandatory = $true)]
  [ValidateSet('classify-backfill', 'refresh-canary', 'refresh-backfill', 'verify-backfill', 'retry-failed')]
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

function Assert-SafetyState {
  $state = gcloud scheduler jobs describe $SchedulerName --location=$Region --project=$ProjectId --format='value(state)'
  if ($state -ne 'PAUSED') { throw "Scheduler must be PAUSED; observed $state" }
  Invoke-CheckedNativeCommand -Command 'node' -Arguments @(
    'scripts/assertCatalogueLegacyMode.mjs', '--project', $ProjectId
  )
}

try {
  Assert-SafetyState
  $jobArgs = @($Mode, '--run-id', $runId)
  if ($Mode -in @('classify-backfill', 'refresh-backfill', 'retry-failed')) {
    $jobArgs += @('--write-cap', [string]$WriteCap)
    $jobArgs += @('--gemini-call-cap', [string]$GeminiCallCap)
  }
  if ($Mode -eq 'refresh-backfill') {
    $jobArgs += @('--max-per-source', [string]$MaxPerSource)
  }
  $encodedArgs = $jobArgs -join ','
  gcloud run jobs execute $JobName `
    --region=$Region `
    --project=$ProjectId `
    --args=$encodedArgs `
    --wait
} finally {
  Assert-SafetyState
}
