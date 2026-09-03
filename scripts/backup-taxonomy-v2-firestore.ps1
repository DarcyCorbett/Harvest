[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z][a-z0-9-]{4,29}$')]
  [string]$ProjectId,
  [string]$Region = 'europe-west1',
  [string]$SchedulerName = 'mealwizard-catalogue-daily',
  [string]$Bucket = "$ProjectId-catalogue-manifests"
)

$ErrorActionPreference = 'Stop'
$state = gcloud scheduler jobs describe $SchedulerName `
  --location=$Region --project=$ProjectId --format='value(state)'
if ($state -ne 'PAUSED') { throw "Scheduler must be PAUSED; observed $state" }
$mode = node scripts/readCatalogueGenerationMode.mjs --project $ProjectId
if ($LASTEXITCODE -ne 0 -or ([string]$mode).Trim() -ne 'catalogue') {
  throw 'Taxonomy-v2 backup requires generationMode=catalogue'
}
$timestamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddHHmmss')
$backupUri = "gs://$Bucket/taxonomy-v2-backups/$timestamp"
gcloud firestore export $backupUri --project=$ProjectId
if ($LASTEXITCODE -ne 0) { throw 'Firestore export failed' }
gcloud storage ls $backupUri --project=$ProjectId | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Firestore export could not be verified' }
Write-Output $backupUri
