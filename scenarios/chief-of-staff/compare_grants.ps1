$S3_INSTANCE  = "48a0b7df-fcd2-4812-9151-ee90b45af1e8"
$COS_INSTANCE = "d35aaf51-693f-4b46-8935-0d8796b96ca3"

function Show-Grants($label, $clientId) {
  Write-Host "=== $label (clientId=$clientId) ==="
  $grants = az rest --method GET --uri "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?`$filter=clientId eq '$clientId'" -o json | ConvertFrom-Json
  if ($grants.value.Count -eq 0) { Write-Host "  (no grants)" }
  foreach ($g in $grants.value) {
    Write-Host "  resourceId=$($g.resourceId)  consentType=$($g.consentType)  principal=$($g.principalId)"
    Write-Host "    scope: $($g.scope)"
  }
  Write-Host ""
}

Show-Grants "sample-agent-3 INSTANCE SP" $S3_INSTANCE
Show-Grants "cos-agent      INSTANCE SP" $COS_INSTANCE

Write-Host "=== App role assignments (application permissions) on each SP ==="
foreach ($sp in @(@{name="sample-agent-3"; id=$S3_INSTANCE}, @{name="cos-agent"; id=$COS_INSTANCE})) {
  $spObj = az ad sp list --filter "appId eq '$($sp.id)'" -o json | ConvertFrom-Json | Select-Object -First 1
  if (-not $spObj) { Write-Host "$($sp.name): SP not found"; continue }
  $assignments = az rest --method GET --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$($spObj.id)/appRoleAssignments" -o json | ConvertFrom-Json
  Write-Host "$($sp.name) INSTANCE SP has $($assignments.value.Count) appRoleAssignment(s)"
}
