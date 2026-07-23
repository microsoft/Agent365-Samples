# bootstrap-graph-app.ps1
#
# One-shot provisioning of the standalone Graph worker app for cos-agent.
# Idempotent — safe to re-run. Requires:
#   - az CLI installed and logged into the target tenant with an admin account
#   - PowerShell 7+
#
# What it does:
#   1. Creates (or finds) an Entra app registration + service principal named
#      "cos-graph-worker".
#   2. Adds the application-permission grants Graph needs for CoS.
#   3. Admin-consents them tenant-wide (one CLI call — no browser).
#   4. Rotates a client secret and prints it, along with GRAPH_APP_ID and
#      GRAPH_TENANT_ID, ready to paste into .env.
#
# NOTE about OnlineMeeting-related Graph APIs:
# Application-permission calls to /users/{id}/onlineMeetings/*, /transcripts,
# and /aiInsights ADDITIONALLY require a Teams application-access policy
# granted to the target user(s). This script emits the two Teams PowerShell
# commands you need to run once as tenant admin — see final output.

$ErrorActionPreference = 'Stop'

$APP_NAME  = 'cos-graph-worker'
$GRAPH_ID  = '00000003-0000-0000-c000-000000000000'

# Application permissions to grant.
$APP_ROLE_NAMES = @(
  'Calendars.Read',
  'OnlineMeetings.Read.All',
  'OnlineMeetingTranscript.Read.All',
  'OnlineMeetingAiInsight.Read.All',
  'Chat.Create',
  'Chat.ReadWrite.All',
  'Tasks.ReadWrite.All',
  'User.Read.All',
  'Group.Read.All'
)

Write-Host '=== 0. Confirming az login ==='
$acct = az account show -o json | ConvertFrom-Json
Write-Host "  tenant: $($acct.tenantId)"
Write-Host "  user  : $($acct.user.name)"

Write-Host ''
Write-Host "=== 1. Ensuring app registration '$APP_NAME' exists ==="
$app = az ad app list --display-name $APP_NAME -o json | ConvertFrom-Json | Select-Object -First 1
if (-not $app) {
  Write-Host "  creating app registration..."
  $app = az ad app create --display-name $APP_NAME --sign-in-audience AzureADMyOrg -o json | ConvertFrom-Json
  Write-Host "  created appId=$($app.appId)"
} else {
  Write-Host "  found existing appId=$($app.appId)"
}
$APP_ID = $app.appId

Write-Host ''
Write-Host "=== 2. Ensuring service principal for '$APP_NAME' exists ==="
$sp = az ad sp list --filter "appId eq '$APP_ID'" -o json | ConvertFrom-Json | Select-Object -First 1
if (-not $sp) {
  Write-Host "  creating service principal..."
  $sp = az ad sp create --id $APP_ID -o json | ConvertFrom-Json
  Write-Host "  created spObjectId=$($sp.id)"
} else {
  Write-Host "  found existing spObjectId=$($sp.id)"
}

Write-Host ''
Write-Host "=== 3. Adding Application permissions on Microsoft Graph ==="
$graphSp = az ad sp show --id $GRAPH_ID -o json | ConvertFrom-Json
foreach ($roleName in $APP_ROLE_NAMES) {
  $role = $graphSp.appRoles | Where-Object { $_.value -eq $roleName }
  if (-not $role) {
    Write-Warning "  SKIP: appRole '$roleName' not found on Graph SP"
    continue
  }
  Write-Host "  adding '$roleName' (id=$($role.id))"
  az ad app permission add --id $APP_ID --api $GRAPH_ID `
      --api-permissions "$($role.id)=Role" 2>&1 | Out-Null
}

Write-Host ''
Write-Host '=== 4. Admin-consenting the app (tenant-wide) ==='
# az's admin-consent for OWN app registrations works and doesn't require a
# browser or the /adminconsent web flow.
az ad app permission admin-consent --id $APP_ID 2>&1 | Out-Host

Write-Host ''
Write-Host '=== 5. Rotating a client secret (12 months) ==='
$cred = az ad app credential reset --id $APP_ID --years 1 --display-name "cos-agent-worker-$(Get-Date -Format 'yyyyMMdd')" -o json | ConvertFrom-Json

Write-Host ''
Write-Host '=== 6. Verifying admin-consent grants landed ==='
Start-Sleep -Seconds 3  # small delay for consent to propagate
$grantsRaw = az rest --method GET --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$($sp.id)/appRoleAssignments" -o json | ConvertFrom-Json
Write-Host "  $($grantsRaw.value.Count) role assignment(s) currently on the SP"
foreach ($g in $grantsRaw.value) {
  $r = $graphSp.appRoles | Where-Object { $_.id -eq $g.appRoleId }
  Write-Host "    - $($r.value)"
}

Write-Host ''
Write-Host '========================================================='
Write-Host 'PASTE THE FOLLOWING INTO .env'
Write-Host '========================================================='
Write-Host "GRAPH_APP_ID=$APP_ID"
Write-Host "GRAPH_APP_SECRET=$($cred.password)"
Write-Host "GRAPH_TENANT_ID=$($acct.tenantId)"
Write-Host '========================================================='

Write-Host ''
Write-Host 'One-more-thing (required for meeting transcript + insights + onlineMeeting reads):'
Write-Host '  OnlineMeetings-related Graph APIs additionally need a Teams application-access policy.'
Write-Host '  This is a TENANT-ADMIN step, done ONCE. Leaders never touch PowerShell.'
Write-Host ''
Write-Host '  Install-Module MicrosoftTeams -Force -Scope CurrentUser'
Write-Host '  Connect-MicrosoftTeams'
Write-Host "  New-CsApplicationAccessPolicy -Identity `"cos-agent-policy`" -AppIds `"$APP_ID`" -Description `"CoS Graph Worker access`""
Write-Host ''
Write-Host '  Then pick ONE of these grant strategies:'
Write-Host ''
Write-Host '  # RECOMMENDED (smallest surface): grant policy to the CoS agent UPN only.'
Write-Host '  # In .env set CAPTURE_GRAPH_OWNER=cos-agent (the default). Any leader who'
Write-Host '  # invites the CoS agent to a meeting is automatically captured.'
Write-Host '  Grant-CsApplicationAccessPolicy -PolicyName "cos-agent-policy" -Identity "<COS_AGENT_UPN>"'
Write-Host ''
Write-Host '  # Alternative: grant tenant-wide (fine for small demo tenants).'
Write-Host '  #   In .env set CAPTURE_GRAPH_OWNER=leader.'
Write-Host '  Grant-CsApplicationAccessPolicy -PolicyName "cos-agent-policy" -Global'
Write-Host ''
Write-Host '  # Alternative: per-leader (production, precise control).'
Write-Host '  #   In .env set CAPTURE_GRAPH_OWNER=leader.'
Write-Host '  Grant-CsApplicationAccessPolicy -PolicyName "cos-agent-policy" -Identity "<LEADER_UPN>"'
Write-Host ''
Write-Host 'Note: policy assignment can take up to 30 min to propagate through Teams.'
Write-Host 'For Calendar, Planner, Users, Groups, Chat.Create — nothing else is needed. Done.'
