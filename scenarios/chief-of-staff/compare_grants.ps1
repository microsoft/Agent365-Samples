# compare_grants.ps1
#
# Diagnostic: list the delegated OAuth2 grants and app-role assignments on
# two agent-instance service principals so you can compare a working agent
# with this one. Pass YOUR OWN instance app (client) ids — none are shipped.
#
#   ./compare_grants.ps1 -CosInstanceAppId <COS_AGENT_INSTANCE_APP_ID> `
#                        -ReferenceInstanceAppId <OTHER_AGENT_INSTANCE_APP_ID>

param(
  [Parameter(Mandatory)][string]$CosInstanceAppId,
  [Parameter(Mandatory)][string]$ReferenceInstanceAppId
)

$ErrorActionPreference = 'Stop'

function Show-Grants($label, $appId) {
  # oauth2PermissionGrant.clientId is the client SP's OBJECT id, not its appId.
  $spObj = az ad sp list --filter "appId eq '$appId'" -o json | ConvertFrom-Json | Select-Object -First 1
  if (-not $spObj) { Write-Host "=== $label (appId=$appId) === SP not found"; Write-Host ""; return }
  $clientId = $spObj.id
  Write-Host "=== $label (appId=$appId, spObjectId=$clientId) ==="
  $grants = az rest --method GET --uri "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?`$filter=clientId eq '$clientId'" -o json | ConvertFrom-Json
  if ($grants.value.Count -eq 0) { Write-Host "  (no grants)" }
  foreach ($g in $grants.value) {
    Write-Host "  resourceId=$($g.resourceId)  consentType=$($g.consentType)  principal=$($g.principalId)"
    Write-Host "    scope: $($g.scope)"
  }
  Write-Host ""
}

Show-Grants "reference INSTANCE SP" $ReferenceInstanceAppId
Show-Grants "cos-agent INSTANCE SP" $CosInstanceAppId

Write-Host "=== App role assignments (application permissions) on each SP ==="
foreach ($sp in @(@{name="reference"; id=$ReferenceInstanceAppId}, @{name="cos-agent"; id=$CosInstanceAppId})) {
  $spObj = az ad sp list --filter "appId eq '$($sp.id)'" -o json | ConvertFrom-Json | Select-Object -First 1
  if (-not $spObj) { Write-Host "$($sp.name): SP not found"; continue }
  $assignments = az rest --method GET --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$($spObj.id)/appRoleAssignments" -o json | ConvertFrom-Json
  Write-Host "$($sp.name) INSTANCE SP has $($assignments.value.Count) appRoleAssignment(s)"
}
