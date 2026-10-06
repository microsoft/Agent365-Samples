<#
.SYNOPSIS
  Step 1 of the Purview demo setup: give the Agent Identity the delegated Microsoft Graph
  permissions that the Purview APIs need, and make them inheritable from the Blueprint.

.DESCRIPTION
  Agent Identities cannot go through an interactive consent prompt (AADSTS82014), so the
  delegated scopes have to be pre-authorised by an admin. This script does it the documented
  way:

    A. Declares the scopes as required resource access on the Blueprint application.
    B. Configures inheritable permissions on the Blueprint (Graph: all allowed scopes) so
       every Agent Identity created from it inherits them.
    C. Grants tenant-wide admin consent (oauth2PermissionGrant) on the Blueprint principal
       AND directly on the Agent Identity (belt and braces — the OBO token is issued to the
       Agent Identity as the client).

  Result: the next OBO token (TR) minted by the sidecar carries the new scopes in `scp`.

.PREREQUISITES
  - Microsoft.Graph PowerShell module (already used by EntraAgentID-Functions.ps1)
  - Sign in as a user with: Agent ID Administrator (or Global Admin) + Privileged Role Admin /
    Application Admin is NOT enough for consent — Global Administrator or Privileged Role
    Administrator is required for tenant-wide delegated consent.

.EXAMPLE
  .\1-Grant-PurviewPermissions.ps1 -TenantId <tenant-guid> -BlueprintAppId <blueprint-app-id> -AgentIdentityId <agent-app-id>
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $TenantId,
    [Parameter(Mandatory)] [string] $BlueprintAppId,     # BLUEPRINT_APP_ID from sidecar/.env
    [Parameter(Mandatory)] [string] $AgentIdentityId     # AGENT_CLIENT_ID from sidecar/.env (= agent SP object id)
)

$ErrorActionPreference = "Stop"

# Delegated Graph scopes the agent needs for Purview DLP + sensitivity labels + reading the demo files.
$PurviewScopes = @(
    "ProtectionScopes.Compute.User",   # POST /me/dataSecurityAndGovernance/protectionScopes/compute
    "Content.Process.User",            # POST /me/dataSecurityAndGovernance/processContent
    "SensitivityLabel.Read",           # GET  /security/dataSecurityAndGovernance/sensitivityLabels
    "SensitivityLabel.Evaluate",       # GET  .../sensitivityLabels/computeInheritance(...)
    "Files.Read.All",                  # GET .../drive/root:/{path}, extractSensitivityLabels
    "Sites.Read.All"                   # GET /sites/{hostname}:/sites/{site} (resolve the SharePoint site)
)
$KeepExisting = @("openid", "profile", "email", "User.Read")   # already in the TR token today

Write-Host "`n== Connecting to Microsoft Graph ==" -ForegroundColor Cyan
# Sign in as Global Administrator (tenant-wide delegated consent) who also holds Agent ID Administrator
Connect-MgGraph -TenantId $TenantId -Scopes @(
    "Application.ReadWrite.All",
    "AgentIdentityBlueprint.ReadWrite.All",     # inheritablePermissions on the Blueprint
    "DelegatedPermissionGrant.ReadWrite.All",
    "Directory.Read.All"
) | Out-Null

# ---- Resolve objects ---------------------------------------------------------------------
$graphSp = (Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '00000003-0000-0000-c000-000000000000'").value[0]
$bpApp   = (Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/applications?`$filter=appId eq '$BlueprintAppId'").value[0]
$bpSp    = (Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '$BlueprintAppId'").value[0]
$agentSp = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/servicePrincipals/$AgentIdentityId"

if (-not $bpApp)   { throw "Blueprint application $BlueprintAppId not found" }
if (-not $agentSp) { throw "Agent Identity service principal $AgentIdentityId not found" }
Write-Host "  Graph SP        : $($graphSp.id)"
Write-Host "  Blueprint app   : $($bpApp.id)  (appId $BlueprintAppId)"
Write-Host "  Blueprint SP    : $($bpSp.id)"
Write-Host "  Agent Identity  : $($agentSp.id)  ($($agentSp.displayName))"

# Map scope names -> Graph oauth2PermissionScope ids
$scopeIds = @{}
foreach ($s in $graphSp.oauth2PermissionScopes) { $scopeIds[$s.value] = $s.id }
foreach ($name in $PurviewScopes) {
    if (-not $scopeIds.ContainsKey($name)) { throw "Scope '$name' not found on the Microsoft Graph service principal in this tenant" }
}

# ---- A. Required resource access on the Blueprint ----------------------------------------
Write-Host "`n== A. Declaring delegated scopes on the Blueprint (requiredResourceAccess) ==" -ForegroundColor Cyan
$rra = @($bpApp.requiredResourceAccess)
$graphEntry = $rra | Where-Object { $_.resourceAppId -eq "00000003-0000-0000-c000-000000000000" }
if (-not $graphEntry) {
    $graphEntry = @{ resourceAppId = "00000003-0000-0000-c000-000000000000"; resourceAccess = @() }
    $rra += $graphEntry
}
$existingIds = @($graphEntry.resourceAccess | ForEach-Object { $_.id })
foreach ($name in $PurviewScopes) {
    if ($existingIds -notcontains $scopeIds[$name]) {
        $graphEntry.resourceAccess += @{ id = $scopeIds[$name]; type = "Scope" }
        Write-Host "  + $name" -ForegroundColor Green
    } else { Write-Host "  = $name (already declared)" -ForegroundColor Gray }
}
try {
    Invoke-MgGraphRequest -Method PATCH -Uri "https://graph.microsoft.com/v1.0/applications/$($bpApp.id)" `
        -Body (@{ requiredResourceAccess = $rra } | ConvertTo-Json -Depth 6) | Out-Null
} catch {
    # Declaration is hygiene, not what drives token issuance (B + C are). Fall back to the portal:
    Write-Warning "  Could not update requiredResourceAccess on the Blueprint ($($_.Exception.Message)). Add the 5 delegated Graph permissions in Entra admin center -> App registrations -> Blueprint -> API permissions, then continue."
}

# ---- B. Inheritable permissions on the Blueprint -----------------------------------------
Write-Host "`n== B. Inheritable permissions on the Blueprint (Graph: all allowed scopes) ==" -ForegroundColor Cyan
# API reference: POST /applications/{id}/microsoft.graph.agentIdentityBlueprint/inheritablePermissions
# Needs AgentIdentityBlueprint.Create / .ReadWrite.All and the caller must own the Blueprint or hold Agent ID Administrator.
$inhUri = "https://graph.microsoft.com/v1.0/applications/$($bpApp.id)/microsoft.graph.agentIdentityBlueprint/inheritablePermissions"
$inhBody = @{
    resourceAppId     = "00000003-0000-0000-c000-000000000000"
    inheritableScopes = @{ "@odata.type" = "microsoft.graph.allAllowedScopes" }
} | ConvertTo-Json -Depth 5
try {
    Invoke-MgGraphRequest -Method POST -Uri $inhUri -Body $inhBody | Out-Null
    Write-Host "  Created inheritablePermissions entry for Microsoft Graph (all delegated scopes inheritable)" -ForegroundColor Green
} catch {
    if ($_.Exception.Message -match "409|Conflict|already") {
        Invoke-MgGraphRequest -Method PATCH -Uri "$inhUri/00000003-0000-0000-c000-000000000000" `
            -Body (@{ inheritableScopes = @{ "@odata.type" = "microsoft.graph.allAllowedScopes" } } | ConvertTo-Json -Depth 5) | Out-Null
        Write-Host "  Updated existing inheritablePermissions entry" -ForegroundColor Yellow
    } else { throw }
}

# ---- C. Admin consent (oauth2PermissionGrant) ---------------------------------------------
function Grant-DelegatedScopes([string]$ClientSpId, [string]$Label) {
    $wanted = ($KeepExisting + $PurviewScopes) | Select-Object -Unique
    $grants = (Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?`$filter=clientId eq '$ClientSpId' and resourceId eq '$($graphSp.id)'").value
    $grant  = $grants | Where-Object { $_.consentType -eq "AllPrincipals" } | Select-Object -First 1
    if ($grant) {
        $merged = (($grant.scope -split " ") + $wanted | Where-Object { $_ } | Select-Object -Unique) -join " "
        Invoke-MgGraphRequest -Method PATCH -Uri "https://graph.microsoft.com/v1.0/oauth2PermissionGrants/$($grant.id)" `
            -Body (@{ scope = $merged } | ConvertTo-Json) | Out-Null
        Write-Host "  $Label : updated grant -> $merged" -ForegroundColor Green
    } else {
        Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/oauth2PermissionGrants" -Body (@{
            clientId    = $ClientSpId
            consentType = "AllPrincipals"
            resourceId  = $graphSp.id
            scope       = ($wanted -join " ")
        } | ConvertTo-Json) | Out-Null
        Write-Host "  $Label : created grant -> $($wanted -join ' ')" -ForegroundColor Green
    }
}
Write-Host "`n== C. Tenant-wide admin consent ==" -ForegroundColor Cyan
Grant-DelegatedScopes -ClientSpId $bpSp.id    -Label "Blueprint principal"
Grant-DelegatedScopes -ClientSpId $agentSp.id -Label "Agent Identity      "

Write-Host "`n== Done ==" -ForegroundColor Cyan
Write-Host "Restart the sidecar container (or wait for its token cache to expire) and send an OBO request."
Write-Host "In the demo UI, the TR token card should now show in scp:" -ForegroundColor Yellow
Write-Host "  $($PurviewScopes -join ' ')" -ForegroundColor Yellow
