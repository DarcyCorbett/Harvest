[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z][a-z0-9-]{4,29}$')][string]$ProjectId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9][a-z0-9._-]+$')][string]$Bucket
)

$ErrorActionPreference = 'Stop'
$timestamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddHHmmss')
$backupUri = "gs://$Bucket/phase3-backups/$timestamp"
gcloud firestore export $backupUri --project=$ProjectId
gcloud storage ls $backupUri --project=$ProjectId | Out-Null
Write-Output $backupUri
