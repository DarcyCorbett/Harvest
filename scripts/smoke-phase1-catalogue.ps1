[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ProjectId,
  [string]$Region = 'europe-west1',
  [string]$JobName = 'mealwizard-catalogue-ingestion'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'gcloudResourceProbe.ps1')
$stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddHHmmss')
$firstRun = "phase1-smoke-$stamp-first"
$secondRun = "phase1-smoke-$stamp-second"
$recipeTin = 'https://www.recipetineats.com/poulet-roti-french-roast-chicken/'
$seriousEats = 'https://www.seriouseats.com/the-best-roast-potatoes-ever-recipe'
$targets = "recipetineats=$recipeTin,seriouseats=$seriousEats"
$baseArguments = "^~^--source~recipetineats,seriouseats~--target~$targets~--write-cap~25~--max-per-source~1"

Invoke-CheckedNativeCommand -Command 'gcloud' -Arguments @('run', 'jobs', 'execute', $JobName, "--region=$Region", "--project=$ProjectId", '--wait', "--args=$baseArguments~--force-refresh~--run-id~$firstRun")
Invoke-CheckedNativeCommand -Command 'gcloud' -Arguments @('run', 'jobs', 'execute', $JobName, "--region=$Region", "--project=$ProjectId", '--wait', "--args=$baseArguments~--run-id~$secondRun")
Invoke-CheckedNativeCommand -Command 'node' -Arguments @('scripts/verifyCatalogueSmoke.mjs', '--project', $ProjectId, '--first-run', $firstRun, '--second-run', $secondRun)

Write-Output "Phase 1 smoke evidence captured for $firstRun and $secondRun."
