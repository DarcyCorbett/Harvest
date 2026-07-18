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
$ingestionAccount = "mealwizard-catalogue@$ProjectId.iam.gserviceaccount.com"
$schedulerAccount = "mealwizard-catalogue-scheduler@$ProjectId.iam.gserviceaccount.com"
$image = "$Region-docker.pkg.dev/$ProjectId/$Repository/catalogue-ingestion:phase1"
$runUri = "https://run.googleapis.com/v2/projects/$ProjectId/locations/$Region/jobs/$JobName`:run"

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  throw 'Google Cloud CLI (gcloud) is required.'
}

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com cloudscheduler.googleapis.com firestore.googleapis.com storage.googleapis.com secretmanager.googleapis.com --project=$ProjectId

if (-not (Test-GcloudResource -Arguments @('artifacts', 'repositories', 'describe', $Repository, "--location=$Region", "--project=$ProjectId"))) {
  gcloud artifacts repositories create $Repository --repository-format=docker --location=$Region --project=$ProjectId
}

if (-not (Test-GcloudResource -Arguments @('storage', 'buckets', 'describe', "gs://$ManifestBucket", "--project=$ProjectId"))) {
  gcloud storage buckets create "gs://$ManifestBucket" --location=$Region --uniform-bucket-level-access --project=$ProjectId
}

foreach ($account in @(
  @{ Name = 'mealwizard-catalogue'; Display = 'MealWizard catalogue ingestion' },
  @{ Name = 'mealwizard-catalogue-scheduler'; Display = 'MealWizard catalogue scheduler' }
)) {
  $email = "$($account.Name)@$ProjectId.iam.gserviceaccount.com"
  if (-not (Test-GcloudResource -Arguments @('iam', 'service-accounts', 'describe', $email, "--project=$ProjectId"))) {
    gcloud iam service-accounts create $account.Name "--display-name=$($account.Display)" --project=$ProjectId
  }
}

foreach ($role in @('roles/datastore.user', 'roles/logging.logWriter')) {
  gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:$ingestionAccount" --role=$role --condition=None --quiet
}
gcloud secrets add-iam-policy-binding mealwizard-gemini-api-key --project=$ProjectId --member="serviceAccount:$ingestionAccount" --role=roles/secretmanager.secretAccessor --quiet
gcloud storage buckets add-iam-policy-binding "gs://$ManifestBucket" --member="serviceAccount:$ingestionAccount" --role=roles/storage.objectAdmin --quiet

gcloud builds submit functions --tag=$image --project=$ProjectId

$jobFlags = @(
  "--image=$image",
  "--region=$Region",
  "--project=$ProjectId",
  "--service-account=$ingestionAccount",
  '--tasks=1',
  '--parallelism=1',
  '--max-retries=3',
  '--task-timeout=3600s',
  "--set-env-vars=CATALOGUE_MANIFEST_BUCKET=$ManifestBucket",
  '--set-secrets=GEMINI_API_KEY=mealwizard-gemini-api-key:latest'
)
if (Test-GcloudResource -Arguments @('run', 'jobs', 'describe', $JobName, "--region=$Region", "--project=$ProjectId")) {
  gcloud run jobs update $JobName @jobFlags
} else {
  gcloud run jobs create $JobName @jobFlags
}

gcloud run jobs add-iam-policy-binding $JobName --region=$Region --project=$ProjectId --member="serviceAccount:$schedulerAccount" --role=roles/run.invoker --quiet

$schedulerFlags = @(
  '--location=europe-west1',
  "--project=$ProjectId",
  '--schedule=0 3 * * *',
  '--time-zone=Asia/Nicosia',
  "--uri=$runUri",
  '--http-method=POST',
  "--oauth-service-account-email=$schedulerAccount"
)
if (Test-GcloudResource -Arguments @('scheduler', 'jobs', 'describe', $SchedulerName, '--location=europe-west1', "--project=$ProjectId")) {
  gcloud scheduler jobs update http $SchedulerName @schedulerFlags
} else {
  gcloud scheduler jobs create http $SchedulerName @schedulerFlags
}
gcloud scheduler jobs pause $SchedulerName --location=europe-west1 --project=$ProjectId

Invoke-CheckedNativeCommand -Command 'npx.cmd' -Arguments @('firebase-tools', 'deploy', '--only', 'functions:selectCatalogueRecipes,functions:updateCanonicalRecipeMetadata,firestore:rules,firestore:indexes', "--project=$ProjectId")
Invoke-CheckedNativeCommand -Command 'node' -Arguments @('scripts/setCatalogueConfig.mjs', '--project', $ProjectId)

Write-Output "Phase 1 infrastructure deployed. Scheduler '$SchedulerName' remains paused and generationMode remains legacy."
