[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ProjectId,
  [string]$Region = 'europe-west1',
  [string]$JobName = 'mealwizard-catalogue-ingestion',
  [string]$SchedulerName = 'mealwizard-catalogue-daily'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'gcloudResourceProbe.ps1')

function Get-SchedulerState {
  $arguments = @(
    'scheduler', 'jobs', 'describe', $SchedulerName,
    "--location=$Region", "--project=$ProjectId", '--format=value(state)'
  )
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = & gcloud @arguments
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0) {
    throw "Unable to read Scheduler state (gcloud exit $exitCode)."
  }
  return ($output | Out-String).Trim()
}

function Assert-SchedulerPaused {
  $state = Get-SchedulerState
  if ($state -ne 'PAUSED') {
    throw "Scheduler '$SchedulerName' must remain PAUSED; observed '$state'."
  }
  return $state
}

if (-not (Test-Path (Join-Path $PSScriptRoot '..\functions\lib\catalogue\selection.js'))) {
  throw 'Functions build is missing. Run npm.cmd run build:functions before the pilot.'
}

$stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddHHmmss')
$discoveryRun = "phase2-pilot-$stamp-discovery"
$firstRun = "phase2-pilot-$stamp-first"
$secondRun = "phase2-pilot-$stamp-second"
$sources = 'recipetineats,seriouseats'
$recipeTinRoast = 'https://www.recipetineats.com/poulet-roti-french-roast-chicken/'
$recipeTinNoodles = 'https://www.recipetineats.com/chow-mein-ramen-noodles-recipe/'
$seriousEatsPotatoes = 'https://www.seriouseats.com/the-best-roast-potatoes-ever-recipe'
$targets = "recipetineats=$recipeTinRoast,recipetineats=$recipeTinNoodles,seriouseats=$seriousEatsPotatoes"
$discoveryArgs = "^~^--source~$sources~--dry-run~--write-cap~40~--run-id~$discoveryRun"
$targetArgs = "^~^--source~$sources~--target~$targets~--write-cap~40~--max-per-source~2"

$schedulerState = Assert-SchedulerPaused
Invoke-CheckedNativeCommand -Command 'gcloud' -Arguments @(
  'run', 'jobs', 'execute', $JobName,
  "--region=$Region", "--project=$ProjectId", '--wait', "--args=$discoveryArgs"
)
Invoke-CheckedNativeCommand -Command 'gcloud' -Arguments @(
  'run', 'jobs', 'execute', $JobName,
  "--region=$Region", "--project=$ProjectId", '--wait',
  "--args=$targetArgs~--force-refresh~--run-id~$firstRun"
)
Invoke-CheckedNativeCommand -Command 'gcloud' -Arguments @(
  'run', 'jobs', 'execute', $JobName,
  "--region=$Region", "--project=$ProjectId", '--wait',
  "--args=$targetArgs~--run-id~$secondRun"
)
$schedulerState = Assert-SchedulerPaused

Invoke-CheckedNativeCommand -Command 'node' -Arguments @(
  (Join-Path $PSScriptRoot 'verifyPhase2Pilot.mjs'),
  '--project', $ProjectId,
  '--discovery-run', $discoveryRun,
  '--first-run', $firstRun,
  '--second-run', $secondRun,
  '--scheduler-state', $schedulerState,
  '--write-cap', '40'
)

Write-Output "Phase 2 pilot evidence captured for $discoveryRun, $firstRun, and $secondRun."
