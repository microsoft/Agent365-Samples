<#
.SYNOPSIS
    Adds inheritable delegated scopes to an Agent Blueprint and
    admin-approves those scopes for the Blueprint service principal.

    Modes:
      • Enumerated scopes (specific list)
      • AllAllowed (microsoft.graph.allAllowedScopes)

.DESCRIPTION
    Uses Graph beta for inheritable scopes and v1.0 for oauth2PermissionGrants.

    Inheritable permissions:
      POST  https://graph.microsoft.com/beta/applications/microsoft.graph.agentIdentityBlueprint/{appObjectId}/inheritablePermissions
      PATCH https://graph.microsoft.com/beta/applications/microsoft.graph.agentIdentityBlueprint/{appObjectId}/inheritablePermissions/{resourceAppId}

    Admin consent (tenant-wide):
      GET   https://graph.microsoft.com/v1.0/oauth2PermissionGrants?$filter=...
      POST  https://graph.microsoft.com/v1.0/oauth2PermissionGrants
      PATCH https://graph.microsoft.com/v1.0/oauth2PermissionGrants/{id}

.PARAMETER TenantId
  AAD tenant id (GUID).

.PARAMETER AgentBlueprintObjectId
  ObjectId of the Agent Blueprint application. Provide this OR AgentBlueprintAppId.

.PARAMETER AgentBlueprintAppId
  AppId (client id) of the Agent Blueprint application. Provide this OR AgentBlueprintObjectId.

.PARAMETER ResourceAppId
  AppId (client id) of the target resource.

.PARAMETER Scopes
  One or more delegated scopes to add as inheritable scopes (enumerated).

.PARAMETER AllAllowed
  Use microsoft.graph.allAllowedScopes (all delegated scopes) for this resource.

.PARAMETER CreateResourceSpIfMissing
  Create the resource service principal in this tenant if it does not exist.

.PARAMETER SkipScopeValidation
  Skip checking that enumerated scopes exist in the resource SP's oauth2PermissionScopes.

.NOTES
  Requires Microsoft Graph PowerShell SDK and sufficient directory/admin privileges.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F-]{36}$')]
  [string]$TenantId,

  [Parameter(Mandatory = $false)]
  [ValidatePattern('^[0-9a-fA-F-]{36}$')]
  [string]$AgentBlueprintObjectId,

  [Parameter(Mandatory = $false)]
  [ValidatePattern('^[0-9a-fA-F-]{36}$')]
  [string]$AgentBlueprintAppId,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F-]{36}$')]
  [Alias('ApiAppId')]
  [string]$ResourceAppId,

  [Parameter(Mandatory = $false)]
  [Alias('Scope')]
  [string[]]$Scopes = @(),

  [Parameter(Mandatory = $false)]
  [switch]$AllAllowed,

  [switch]$CreateResourceSpIfMissing,
  [switch]$SkipScopeValidation
)

function Write-Info { param([string]$m) Write-Host $m -ForegroundColor Cyan }
function Write-Warn { param([string]$m) Write-Host $m -ForegroundColor Yellow }
function Write-Err  { param([string]$m) Write-Host "ERROR: $m" -ForegroundColor Red }

function Show-GraphError {
  param($err)

  Write-Host "----------- GRAPH ERROR -----------" -ForegroundColor Red

  if ($err.ErrorDetails -and $err.ErrorDetails.Message) {
    Write-Host $err.ErrorDetails.Message -ForegroundColor Yellow
    try {
      ($err.ErrorDetails.Message | ConvertFrom-Json).error | Format-List * | Out-String | Write-Host
    } catch {}
  }

  if ($err.Exception.Response) {
    try {
      $resp = $err.Exception.Response
      if ($resp.Content) {
        Write-Host "Raw Response (ToString()):" -ForegroundColor Yellow
        $resp.Content.ToString() | Write-Host
      }
    } catch {}
  }

  Write-Host $err.Exception.Message -ForegroundColor Yellow
}

function Resolve-Blueprint {
  param([string]$ObjectId,[string]$AppId)

  if (-not $ObjectId -and -not $AppId) {
    throw "Provide either -AgentBlueprintObjectId or -AgentBlueprintAppId."
  }

  if ($ObjectId) {
    $app = Get-MgApplication -ApplicationId $ObjectId -ErrorAction Stop
    return @{ ObjectId = $ObjectId; AppId = $app.AppId }
  } else {
    $app = Get-MgApplication -Filter "appId eq '$AppId'"
    if (-not $app) { throw "No application found for appId '$AppId'." }
    if ($app -is [array]) { $app = $app[0] }
    return @{ ObjectId = $app.Id; AppId = $app.AppId }
  }
}

function Grant-AdminConsentForScopes {
  param(
    [Parameter(Mandatory=$true)] [string]$BlueprintSpId,
    [Parameter(Mandatory=$true)] [string]$ResourceSpId,
    [Parameter(Mandatory=$true)] [string[]]$ScopesToGrant
  )

  # Flatten & de-dupe
  $ScopesToGrant = @(
    $ScopesToGrant |
      Where-Object { $_ -and $_.Trim() -ne "" } |
      ForEach-Object { $_.Trim() } |
      Select-Object -Unique
  )
  if ($ScopesToGrant.Count -eq 0) {
    Write-Warn "No scopes to admin-approve for resource SP $ResourceSpId."
    return
  }

  $scopeStringToAdd = $ScopesToGrant -join " "

  Write-Info "Ensuring admin consent for scopes: $scopeStringToAdd"

  # Find existing oauth2PermissionGrant (AllPrincipals) for this client/resource
  $filter = "clientId eq '$BlueprintSpId' and resourceId eq '$ResourceSpId' and consentType eq 'AllPrincipals'"

  try {
    $url = "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?`$filter=$([System.Uri]::EscapeDataString($filter))"
    $existing = Invoke-MgGraphRequest -Method GET -Uri $url

    $grant = $null
    if ($existing.value -and $existing.value.Count -gt 0) {
      $grant = $existing.value[0]
    }

    if ($grant) {
      # Merge scopes
      $existingScopes = @()
      if ($grant.scope) {
        $existingScopes = $grant.scope -split ' ' | Where-Object { $_ -and $_.Trim() -ne "" }
      }
      $union = @($existingScopes + $ScopesToGrant | Select-Object -Unique)
      $newScopeString = $union -join " "

      if ($newScopeString -eq $grant.scope) {
        Write-Host "Admin consent already covers these scopes." -ForegroundColor Gray
      } else {
        Write-Info "Updating existing oauth2PermissionGrant $($grant.id) with scopes:"
        Write-Host $newScopeString -ForegroundColor Gray

        Invoke-MgGraphRequest -Method PATCH `
          -Uri "https://graph.microsoft.com/v1.0/oauth2PermissionGrants/$($grant.id)" `
          -Body (@{ scope = $newScopeString } | ConvertTo-Json) | Out-Null

        Write-Host "✓ Admin consent updated for Blueprint SP." -ForegroundColor Green
      }
    } else {
      # Create new grant
      $body = @{
        clientId    = $BlueprintSpId
        consentType = "AllPrincipals"
        principalId = $null
        resourceId  = $ResourceSpId
        scope       = $scopeStringToAdd
      }

      Write-Info "Creating new oauth2PermissionGrant for Blueprint SP."
      Write-Host ($body | ConvertTo-Json -Depth 4) -ForegroundColor Gray

      Invoke-MgGraphRequest -Method POST `
        -Uri "https://graph.microsoft.com/v1.0/oauth2PermissionGrants" `
        -Body ($body | ConvertTo-Json) | Out-Null

      Write-Host "✓ Admin consent created for Blueprint SP." -ForegroundColor Green
    }
  } catch {
    Write-Err "Failed to admin-approve scopes for Blueprint SP."
    Show-GraphError $_
    throw
  }
}

# ---------- Normalize scopes ----------
$Scopes = @(
  $Scopes |
    Where-Object { $_ -and $_.Trim() -ne "" } |
    ForEach-Object { $_.Trim() } |
    Select-Object -Unique
)

if ($AllAllowed -and $Scopes.Count -gt 0) {
  Write-Warn "-AllAllowed provided → ignoring enumerated scopes."
  $Scopes = @()
}

# ---------- Connect ----------
Write-Info "Connecting to Microsoft Graph..."
Connect-MgGraph -TenantId $TenantId | Out-Null

# ---------- Resolve blueprint ----------
try {
  $bp = Resolve-Blueprint -ObjectId $AgentBlueprintObjectId -AppId $AgentBlueprintAppId
} catch {
  Write-Err $_.Exception.Message
  exit 1
}

$bpObjectId = $bp.ObjectId
$bpAppId    = $bp.AppId
$bpSp       = Get-MgServicePrincipal -Filter "appId eq '$bpAppId'"

if (-not $bpSp) {
  Write-Err "Blueprint service principal not found (appId $bpAppId). Ensure a service principal exists."
  exit 1
}

Write-Info "Blueprint ObjectId: $bpObjectId"
Write-Info "Blueprint SP Id:    $($bpSp.Id)"
Write-Info "Resource AppId:     $ResourceAppId"
Write-Info "Scopes:             $($Scopes -join ', ')"
Write-Host ""

# ---------- Get or create resource SP ----------
$resourceSp = Get-MgServicePrincipal -Filter "appId eq '$ResourceAppId'"

if (-not $resourceSp -and $CreateResourceSpIfMissing) {
  Write-Info "Creating service principal for resource $ResourceAppId..."
  Invoke-MgGraphRequest -Method POST `
    -Uri "https://graph.microsoft.com/beta/serviceprincipals" `
    -Headers @{ "OData-Version" = "4.0" } `
    -Body (@{ appId = $ResourceAppId } | ConvertTo-Json) | Out-Null

  $resourceSp = Get-MgServicePrincipal -Filter "appId eq '$ResourceAppId'"
}

if (-not $resourceSp) {
  Write-Err "Resource service principal not found in tenant for appId '$ResourceAppId'."
  exit 1
}

# ---------- Inheritable permissions ----------
$baseUri = "https://graph.microsoft.com/beta/applications/microsoft.graph.agentIdentityBlueprint/$bpObjectId/inheritablePermissions"
$headers = @{ "OData-Version" = "4.0" }

# Check existing entry
$existingEntry = $null
try {
  $existing = Invoke-MgGraphRequest -Method GET -Uri $baseUri -Headers $headers
  $existingEntry = @($existing.value | Where-Object { $_.resourceAppId -eq $ResourceAppId })
  if ($existingEntry.Count -gt 0) { $existingEntry = $existingEntry[0] } else { $existingEntry = $null }
} catch {}

# ---------- AllAllowed ----------
if ($AllAllowed) {
  $payload = @{
    resourceAppId     = $ResourceAppId
    inheritableScopes = @{
      "@odata.type" = "microsoft.graph.allAllowedScopes"
    }
  }

  $json = $payload | ConvertTo-Json -Depth 5
  Write-Info "Upserting AllAllowed for resource $ResourceAppId"
  Write-Host $json -ForegroundColor Gray

  try {
    if ($existingEntry) {
      Invoke-MgGraphRequest -Method PATCH `
        -Uri "$baseUri/$ResourceAppId" `
        -Headers $headers `
        -Body (@{ inheritableScopes = @{ "@odata.type"="microsoft.graph.allAllowedScopes" } } | ConvertTo-Json) | Out-Null
    } else {
      Invoke-MgGraphRequest -Method POST -Uri $baseUri -Headers $headers -Body $json | Out-Null
    }
    Write-Host "✓ AllAllowed inheritable scopes set successfully." -ForegroundColor Green
  } catch {
    Write-Err "Failed to update inheritable permissions (AllAllowed)."
    Show-GraphError $_
    exit 1
  }

  # Admin-consent: all delegated scopes published by the resource
  $delegatedValues = @($resourceSp.Oauth2PermissionScopes | ForEach-Object { $_.Value }) |
                     Where-Object { $_ -and $_.Trim() -ne "" } |
                     Select-Object -Unique
  if ($delegatedValues.Count -gt 0) {
    Grant-AdminConsentForScopes -BlueprintSpId $bpSp.Id -ResourceSpId $resourceSp.Id -ScopesToGrant $delegatedValues
  } else {
    Write-Warn "Resource has no delegated oauth2PermissionScopes; nothing to admin-approve."
  }

  Write-Info "Done."
  exit 0
}

# ---------- Enumerated scopes ----------
if ($Scopes.Count -gt 0) {

  # Validate scope names against resource
  if (-not $SkipScopeValidation) {
    $published = @($resourceSp.Oauth2PermissionScopes | ForEach-Object { $_.Value })
    $missing   = $Scopes | Where-Object { $published -notcontains $_ }

    if ($missing.Count -gt 0) {
      Write-Warn "These scopes are NOT published by the resource: $($missing -join ', ')"
      Write-Warn "Published: $($published -join ', ')"
    }
  }

  $body = @{
    resourceAppId     = $ResourceAppId
    inheritableScopes = @{
      "@odata.type" = "microsoft.graph.enumeratedScopes"
      scopes        = @($Scopes)   # force array
    }
  }

  $json = $body | ConvertTo-Json -Depth 6
  Write-Info "Upserting enumerated scopes for resource $ResourceAppId"
  Write-Host $json -ForegroundColor Gray

  try {
    if ($existingEntry) {
      Invoke-MgGraphRequest -Method PATCH `
        -Uri "$baseUri/$ResourceAppId" -Headers $headers -Body $json | Out-Null
    } else {
      Invoke-MgGraphRequest -Method POST -Uri $baseUri -Headers $headers -Body $json | Out-Null
    }
    Write-Host "✓ Enumerated inheritable scopes updated successfully." -ForegroundColor Green
  } catch {
    Write-Err "Failed to update inheritable scopes (enumerated)."
    Show-GraphError $_
    exit 1
  }

  # Admin-consent only for the enumerated scopes
  Grant-AdminConsentForScopes -BlueprintSpId $bpSp.Id -ResourceSpId $resourceSp.Id -ScopesToGrant $Scopes
}

Write-Info "Done."
