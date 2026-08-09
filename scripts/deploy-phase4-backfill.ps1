[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z][a-z0-9-]{4,29}$')][string]$ProjectId,
  [string]$Region = 'europe-west1',
  [string]$Repository = 'mealwizard',
  [string]$JobName = 'mealwizard-catalogue-ingestion',
  [string]$SchedulerName = 'mealwizard-catalogue-daily',
  [string]$ManifestBucket = "$ProjectId-catalogue-manifests"
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'gcloudResourceProbe.ps1')
$serviceAccount = "mealwizard-catalogue@$ProjectId.iam.gserviceaccount.com"
$image = "$Region-docker.pkg.dev/$ProjectId/$Repository/catalogue-ingestion:phase4"

function Get-SafetyMode {
  $state = gcloud scheduler jobs describe $SchedulerName --location=$Region --project=$ProjectId --format='value(state)'
  if ($state -ne 'PAUSED') { throw "Scheduler must be PAUSED; observed $state" }
  $mode = node scripts/readCatalogueGenerationMode.mjs --project $ProjectId
  if ($LASTEXITCODE -ne 0) { throw 'Could not read catalogue generation mode' }
  return ([string]$mode).Trim()
}

$initialMode = Get-SafetyMode
gcloud builds submit functions --tag=$image --project=$ProjectId

$jobFlags = @(
  "--image=$image",
  "--region=$Region",
  "--project=$ProjectId",
  "--service-account=$serviceAccount",
  '--tasks=1',
  '--parallelism=1',
  '--max-retries=0',
  '--task-timeout=86400s',
  "--set-env-vars=CATALOGUE_MANIFEST_BUCKET=$ManifestBucket",
  '--set-secrets=GEMINI_API_KEY=mealwizard-gemini-api-key:latest'
)
if (Test-GcloudResource -Arguments @(
  'run', 'jobs', 'describe', $JobName, "--region=$Region", "--project=$ProjectId"
)) {
  gcloud run jobs update $JobName @jobFlags
} else {
  gcloud run jobs create $JobName @jobFlags
}

Invoke-CheckedNativeCommand -Command 'npx.cmd' -Arguments @(
  'firebase-tools', 'deploy', '--only', 'firestore:rules', "--project=$ProjectId"
)
$finalMode = Get-SafetyMode
if ($finalMode -ne $initialMode) {
  throw "Generation mode changed during deployment: $initialMode -> $finalMode"
}
Write-Output "Phase 4 ingestion image deployed dormant; Scheduler remains paused and generation mode remains $initialMode."
