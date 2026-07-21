[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z][a-z0-9-]{4,29}$')][string]$ProjectId,
  [Parameter(Mandatory = $true)]
  [ValidateSet('dry-run', 'migrate-recipes', 'migrate-references', 'reconcile', 'verify')]
  [string]$Stage,
  [string]$Region = 'europe-west1',
  [string]$JobName = 'mealwizard-catalogue-migration',
  [string]$SchedulerName = 'mealwizard-catalogue-daily',
  [ValidateRange(1, 8000)][int]$MaxWrites = 8000,
  [ValidateRange(0, 10000)][int]$MaxReferences = 0,
  [string]$BackupUri
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'gcloudResourceProbe.ps1')
$mutatingStages = @('migrate-recipes', 'migrate-references', 'reconcile')
$runId = "phase3-$Stage-$([DateTimeOffset]::UtcNow.ToString('yyyyMMddHHmmss'))"

function Assert-SafetyState {
  $state = gcloud scheduler jobs describe $SchedulerName --location=$Region --project=$ProjectId --format='value(state)'
  if ($state -ne 'PAUSED') { throw "Scheduler must be PAUSED; observed $state" }
  Invoke-CheckedNativeCommand -Command 'node' -Arguments @('scripts/assertCatalogueLegacyMode.mjs', '--project', $ProjectId)
}

try {
  Assert-SafetyState
  if ($Stage -in $mutatingStages) {
    if ($BackupUri -notmatch '^gs://') { throw 'A verified gs:// Firestore backup URI is required for mutating stages.' }
    gcloud storage ls $BackupUri --project=$ProjectId | Out-Null
  }
  $jobArgs = @($Stage, '--run-id', $runId)
  if ($Stage -in @('migrate-recipes', 'reconcile')) { $jobArgs += @('--max-writes', [string]$MaxWrites) }
  if ($Stage -eq 'migrate-references' -and $MaxReferences -gt 0) {
    $jobArgs += @('--max-references', [string]$MaxReferences)
  }
  $encodedArgs = $jobArgs -join ','
  gcloud run jobs execute $JobName --region=$Region --project=$ProjectId --args=$encodedArgs --wait
} finally {
  Assert-SafetyState
}
