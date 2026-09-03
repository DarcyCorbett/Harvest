[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z][a-z0-9-]{4,29}$')]
  [string]$ProjectId,
  [string]$Region = 'europe-west1',
  [string]$Repository = 'mealwizard',
  [string]$JobName = 'mealwizard-catalogue-ingestion',
  [string]$SchedulerName = 'mealwizard-catalogue-daily',
  [string]$ManifestBucket = "$ProjectId-catalogue-manifests"
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'gcloudResourceProbe.ps1')
$serviceAccount = "mealwizard-catalogue@$ProjectId.iam.gserviceaccount.com"
$image = "$Region-docker.pkg.dev/$ProjectId/$Repository/catalogue-ingestion:taxonomy-v2"

function Assert-SafetyState {
  $state = gcloud scheduler jobs describe $SchedulerName `
    --location=$Region --project=$ProjectId --format='value(state)'
  if ($state -ne 'PAUSED') { throw "Scheduler must be PAUSED; observed $state" }
  $mode = node scripts/readCatalogueGenerationMode.mjs --project $ProjectId
  if ($LASTEXITCODE -ne 0 -or ([string]$mode).Trim() -ne 'catalogue') {
    throw 'Taxonomy v2 requires generationMode=catalogue'
  }
}

Assert-SafetyState
gcloud builds submit functions --tag=$image --project=$ProjectId
if ($LASTEXITCODE -ne 0) { throw 'Taxonomy-v2 image build failed' }

$jobFlags = @(
  "--image=$image",
  "--region=$Region",
  "--project=$ProjectId",
  "--service-account=$serviceAccount",
  '--tasks=1',
  '--parallelism=1',
  '--memory=2Gi',
  '--max-retries=0',
  '--task-timeout=86400s',
  "--set-env-vars=CATALOGUE_MANIFEST_BUCKET=$ManifestBucket",
  '--set-secrets=GEMINI_API_KEY=mealwizard-gemini-api-key:latest'
)
gcloud run jobs update $JobName @jobFlags
if ($LASTEXITCODE -ne 0) { throw 'Taxonomy-v2 Cloud Run Job update failed' }

Invoke-CheckedNativeCommand -Command 'npx.cmd' -Arguments @(
  'firebase-tools', 'deploy',
  '--only', 'functions:selectCatalogueRecipes,functions:updateCanonicalRecipeMetadata,firestore:rules,firestore:indexes',
  "--project=$ProjectId"
)
Assert-SafetyState
Write-Output "Taxonomy v2 deployed dormant; Scheduler remains paused and catalogue generation remains active."
