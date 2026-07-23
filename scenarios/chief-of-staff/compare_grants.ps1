# ──────────────────────────────────────────────────────────────────────────
#  Compare delegated permission grants and app-role assignments between two
#  Agent 365 agent instance service principals — useful when diagnosing
#  "why does agent A see tool X but agent B doesn't?".
#
#  Usage:
#    1. Replace both placeholders below with the agent-instance appIds you
#       want to compare. Get them from the Entra portal or:
#         az ad sp list --filter "servicePrincipalType eq 'Application' and \
#           tags/any(t:t eq 'WindowsAzureActiveDirectoryIntegratedApp')"
#    2. Run:  pwsh ./compare_grants.ps1
#
#  Requires Azure CLI (`az`) signed in with directory read access.
# ──────────────────────────────────────────────────────────────────────────

$AGENT_A_INSTANCE = "<AGENT_A_INSTANCE_APP_ID>"           # e.g. 12345678-1234-1234-1234-123456789012
$AGENT_B_INSTANCE = "<AGENT_B_INSTANCE_APP_ID>"           # e.g. 87654321-4321-4321-4321-210987654321
$AGENT_A_LABEL    = "agent-a"
$AGENT_B_LABEL    = "agent-b"

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

Show-Grants "$AGENT_A_LABEL INSTANCE SP" $AGENT_A_INSTANCE
Show-Grants "$AGENT_B_LABEL INSTANCE SP" $AGENT_B_INSTANCE

Write-Host "=== App role assignments (application permissions) on each SP ==="
foreach ($sp in @(@{name=$AGENT_A_LABEL; id=$AGENT_A_INSTANCE}, @{name=$AGENT_B_LABEL; id=$AGENT_B_INSTANCE})) {
  $spObj = az ad sp list --filter "appId eq '$($sp.id)'" -o json | ConvertFrom-Json | Select-Object -First 1
  if (-not $spObj) { Write-Host "$($sp.name): SP not found"; continue }
  $assignments = az rest --method GET --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$($spObj.id)/appRoleAssignments" -o json | ConvertFrom-Json
  Write-Host "$($sp.name) INSTANCE SP has $($assignments.value.Count) appRoleAssignment(s)"
}
