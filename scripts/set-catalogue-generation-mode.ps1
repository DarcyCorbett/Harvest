[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z][a-z0-9-]{4,29}$')]
  [string]$ProjectId,
  [Parameter(Mandatory = $true)]
  [ValidateSet('legacy', 'catalogue')]
  [string]$Mode,
  [string]$Region = 'europe-west1',
  [string]$SchedulerName = 'mealwizard-catalogue-daily'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'gcloudResourceProbe.ps1')

function Assert-SchedulerPaused {
  $state = gcloud scheduler jobs describe $SchedulerName `
    --location=$Region `
    --project=$ProjectId `
    --format='value(state)'
  if ($state -ne 'PAUSED') {
    throw "Scheduler must be PAUSED; observed $state"
  }
}

try {
  Assert-SchedulerPaused
  Invoke-CheckedNativeCommand -Command 'node' -Arguments @(
    'scripts/setCatalogueGenerationMode.mjs',
    '--project', $ProjectId,
    '--mode', $Mode
  )
} finally {
  Assert-SchedulerPaused
}
