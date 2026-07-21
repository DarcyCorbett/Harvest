[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z][a-z0-9-]{4,29}$')][string]$ProjectId,
  [string]$Region = 'europe-west1',
  [string]$Repository = 'mealwizard',
  [string]$JobName = 'mealwizard-catalogue-migration',
  [string]$SchedulerName = 'mealwizard-catalogue-daily'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'gcloudResourceProbe.ps1')
$serviceAccount = "mealwizard-catalogue@$ProjectId.iam.gserviceaccount.com"
$image = "$Region-docker.pkg.dev/$ProjectId/$Repository/catalogue-migration:phase3"

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  throw 'Google Cloud CLI (gcloud) is required.'
}

$schedulerState = gcloud scheduler jobs describe $SchedulerName --location=$Region --project=$ProjectId --format='value(state)'
if ($schedulerState -ne 'PAUSED') { throw "Scheduler must be PAUSED; observed $schedulerState" }
Invoke-CheckedNativeCommand -Command 'node' -Arguments @('scripts/assertCatalogueLegacyMode.mjs', '--project', $ProjectId)

gcloud builds submit . --config=cloudbuild-phase3-migration.yaml --substitutions="_IMAGE=$image" --project=$ProjectId

$jobFlags = @(
  "--image=$image",
  "--region=$Region",
  "--project=$ProjectId",
  "--service-account=$serviceAccount",
  '--tasks=1',
  '--parallelism=1',
  '--max-retries=0',
  '--task-timeout=86400s'
)
if (Test-GcloudResource -Arguments @('run', 'jobs', 'describe', $JobName, "--region=$Region", "--project=$ProjectId")) {
  gcloud run jobs update $JobName @jobFlags
} else {
  gcloud run jobs create $JobName @jobFlags
}

Invoke-CheckedNativeCommand -Command 'npx.cmd' -Arguments @(
  'firebase-tools', 'deploy', '--only', 'firestore:rules', "--project=$ProjectId"
)

$schedulerState = gcloud scheduler jobs describe $SchedulerName --location=$Region --project=$ProjectId --format='value(state)'
if ($schedulerState -ne 'PAUSED') { throw "Scheduler changed state; observed $schedulerState" }
Invoke-CheckedNativeCommand -Command 'node' -Arguments @('scripts/assertCatalogueLegacyMode.mjs', '--project', $ProjectId)
Write-Output "Migration job '$JobName' deployed with one task and no Scheduler trigger."
