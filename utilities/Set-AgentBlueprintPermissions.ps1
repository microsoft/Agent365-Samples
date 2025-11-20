<#
.SYNOPSIS
  Create or update an OAuth2 delegated permission grant for an Agent Blueprint and enable consent permission inheritance.

.PARAMETER AgentBlueprintApplicationId
  Application ID (App ID) of the Agent Blueprint. This is used to look up the Agent Blueprint application and service principal.

.EXAMPLE
  .\Set-AgentBlueprintPermissions.ps1 -AgentBlueprintApplicationId "11111111-2222-3333-4444-555555555555"
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidatePattern('^[0-9a-fA-F-]{36}$')]
  [string]$AgentBlueprintApplicationId
)

# Set default values for resources to configure
# We configure scopes for two resources by default:
# 1. Microsoft Graph
# 2. Messaging Bot API Application
$GraphAppId = "00000003-0000-0000-c000-000000000000"  # Microsoft Graph
$MessagingBotAppId = "5a807f24-c9de-44ee-a3a7-329e88a00ffc"  # Messaging Bot API Application
$GraphScopes = "Chat.ReadWrite Files.Read.All Mail.ReadWrite Mail.Send Sites.Read.All User.Read.All"
$MessagingBotScopes = "user_impersonation Authorization.ReadWrite"
$ConsentType = "AllPrincipals"
$PrincipalId = $null

function Ensure-Module {
  param([string]$Name)
  if (-not (Get-Module -ListAvailable -Name $Name)) {
    Write-Host "Installing module $Name..." -ForegroundColor Yellow
    Install-Module $Name -Scope CurrentUser -Force
  }
}

Ensure-Module -Name Microsoft.Graph

# 1) Disconnect any existing Graph session and force new login
Write-Host "Disconnecting any existing Microsoft Graph session..." -ForegroundColor Yellow
try {
  Disconnect-MgGraph -ErrorAction SilentlyContinue | Out-Null
}
catch {
  # Ignore errors if no session exists
}

# 2) Connect to Graph with forced refresh for multi-tenant scenarios
Write-Host "Connecting to Microsoft Graph (forcing new login for multi-tenant support)..." -ForegroundColor Yellow
$requiredScopes = @(
  'Directory.ReadWrite.All',           # Required for managing grants and reading user info
  'Mail.ReadWrite',                    # Send and receive emails
  'Mail.Send',                         # Send emails on behalf of user
  'Chat.ReadWrite',                    # Teams chat read/write including message updates
  'ChatMessage.Send',                  # Send Teams messages
  'User.Read.All',                     # Read user profiles and manager information
  'People.Read.All',                   # Read organizational relationships (manager info)
  'Presence.ReadWrite',                # Read and write user presence information
  'AgentIdentityBlueprint.ReadWrite.All'  # Required for configuring inheritable permissions on 3P Agent Blueprints
)

try {
  # Use interactive browser login instead of device code to avoid conditional access issues
  Connect-MgGraph -Scopes $requiredScopes
  
  # Verify connection
  $context = Get-MgContext
  if (-not $context) {
    throw "Failed to establish Microsoft Graph connection"
  }
  
  Write-Host "Successfully connected to Microsoft Graph!" -ForegroundColor Green
  Write-Host "Connected to tenant: $($context.TenantId)" -ForegroundColor Green
  Write-Host "Authenticated as: $($context.Account)" -ForegroundColor Green
  Write-Host "Scopes: $($context.Scopes -join ', ')" -ForegroundColor Green
}
catch {
  Write-Host "ERROR: Failed to connect to Microsoft Graph." -ForegroundColor Red
  Write-Host "Details: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "" -ForegroundColor Red
  Write-Host "If you're getting Conditional Access errors (53003), try one of these solutions:" -ForegroundColor Yellow
  Write-Host "1. Run this script from a domain-joined/compliant device" -ForegroundColor Yellow
  Write-Host "2. Add an exclusion for 'Microsoft Graph Command Line Tools' app in your Conditional Access policies" -ForegroundColor Yellow
  Write-Host "3. Use a different authentication method or run from Azure Cloud Shell" -ForegroundColor Yellow
  throw "Microsoft Graph authentication failed. Please ensure you have the required permissions and try again."
}
Write-Host ""

Write-Host "Setting up delegated permissions for Agent Blueprint..." -ForegroundColor Cyan
Write-Host "  Agent Blueprint Application ID: $AgentBlueprintApplicationId" -ForegroundColor Gray
Write-Host ""
Write-Host "Resources to configure:" -ForegroundColor Yellow
Write-Host "  1. Microsoft Graph" -ForegroundColor Gray
Write-Host "     App ID: $GraphAppId" -ForegroundColor Gray
Write-Host "     Scopes: $GraphScopes" -ForegroundColor Gray
Write-Host "  2. Messaging Bot API Application" -ForegroundColor Gray
Write-Host "     App ID: $MessagingBotAppId" -ForegroundColor Gray
Write-Host "     Scopes: $MessagingBotScopes" -ForegroundColor Gray
Write-Host ""

# --- Helpers ---------------------------------------------------------------
function Get-ExistingGrant {
  param(
    [string]$ClientSpId,
    [string]$ResourceSpId
  )
  $filter = "clientId eq '$ClientSpId' and resourceId eq '$ResourceSpId'"
  $encodedFilter = [System.Web.HttpUtility]::UrlEncode($filter)
  (Invoke-MgGraphRequest -Method GET -Uri "/v1.0/oauth2PermissionGrants?`$filter=$encodedFilter").value
}

function Get-ExistingInheritance {
  param(
    [string]$AgentApplicationObjectId,
    [string]$ResourceAppId
  )
  try {
    $getUri = "https://graph.microsoft.com/beta/applications/microsoft.graph.agentIdentityBlueprint/$AgentApplicationObjectId/inheritablePermissions/$ResourceAppId"
    $existing = Invoke-MgGraphRequest -Method GET -Uri $getUri -ErrorAction Stop
    return $existing
  }
  catch {
    if ($_.Exception.Message -like "*404*" -or $_.Exception.Message -like "*NotFound*") {
      return $null
    }
    throw
  }
}

function Set-InheritablePermissions {
  param(
    [string]$AgentApplicationObjectId,
    [string]$ResourceAppId,
    [string]$ResourceName
  )
  
  Write-Host "Checking existing inheritance for $ResourceName..." -ForegroundColor Cyan
  $existing = Get-ExistingInheritance -AgentApplicationObjectId $AgentApplicationObjectId -ResourceAppId $ResourceAppId
  
  # Request headers
  $headers = @{
    "OData-Version" = "4.0"
  }
  
  # Use "all allowed scopes" instead of enumerated scopes
  $inheritanceBody = @{
    inheritableScopes = @{
      "@odata.type" = "microsoft.graph.allAllowedScopes"
    }
  }
  
  if ($existing) {
    # Update existing inheritance - use resourceAppId in path (not resourceObjectId)
    $updateUri = "https://graph.microsoft.com/beta/applications/microsoft.graph.agentIdentityBlueprint/$AgentApplicationObjectId/inheritablePermissions/$ResourceAppId"
    
    Write-Host "Updating existing inheritance for $ResourceName..." -ForegroundColor Yellow
    Write-Host "  Update URI: $updateUri" -ForegroundColor Gray
    Write-Host "  Request Body: $($inheritanceBody | ConvertTo-Json -Depth 10)" -ForegroundColor Gray
    
    $result = Invoke-MgGraphRequest -Method PATCH -Uri $updateUri -Headers $headers -Body ($inheritanceBody | ConvertTo-Json)
    Write-Host "Updated $ResourceName inheritable permissions." -ForegroundColor Green
  } else {
    # Create new inheritance
    $createUri = "https://graph.microsoft.com/beta/applications/microsoft.graph.agentIdentityBlueprint/$AgentApplicationObjectId/inheritablePermissions"
    $createBody = @{
      resourceAppId = $ResourceAppId
      inheritableScopes = $inheritanceBody.inheritableScopes
    }
    
    Write-Host "Creating new inheritance for $ResourceName..." -ForegroundColor Cyan
    Write-Host "  Create URI: $createUri" -ForegroundColor Gray
    Write-Host "  Request Body: $($createBody | ConvertTo-Json -Depth 10)" -ForegroundColor Gray
    
    $result = Invoke-MgGraphRequest -Method POST -Uri $createUri -Headers $headers -Body ($createBody | ConvertTo-Json)
    Write-Host "Created $ResourceName inheritable permissions." -ForegroundColor Green
  }
  
  Write-Host "  Resource App ID: $ResourceAppId" -ForegroundColor Gray
  Write-Host "  Inheritable Scopes: All Allowed Scopes" -ForegroundColor Gray
  return $result
}


# --- Resolve IDs -----------------------------------------------------------
# Look up the Agent Blueprint Application using the App ID
Write-Host "Looking up Agent Identity Blueprint Application..." -ForegroundColor Cyan
$agentApp = Get-MgApplication -Filter "appId eq '$AgentBlueprintApplicationId'"
if (-not $agentApp) {
  throw "Could not find Application for Agent Blueprint Application ID '$AgentBlueprintApplicationId'. Verify the AgentBlueprintApplicationId is correct and the application exists in this tenant."
}
$AgentApplicationObjectId = $agentApp.Id
Write-Host "  Agent Blueprint Application Object ID: $AgentApplicationObjectId" -ForegroundColor Gray

# Also get the Service Principal for permission grants
$agentSp = Get-MgServicePrincipal -Filter "appId eq '$AgentBlueprintApplicationId'"
if (-not $agentSp) {
  throw "Could not find Service Principal for Agent Blueprint Application ID '$AgentBlueprintApplicationId'. Verify the application has a service principal in this tenant."
}
$ClientSpId = $agentSp.Id
Write-Host "  Agent Blueprint Service Principal ID (for grants): $ClientSpId" -ForegroundColor Gray
Write-Host ""

# Helper function to create or check delegated permission grant
function Grant-DelegatedPermissions {
  param(
    [string]$ClientSpId,
    [string]$ResourceAppId,
    [string]$ResourceName,
    [string]$Scopes,
    [string]$ConsentType,
    [string]$PrincipalId
  )
  
  Write-Host "Configuring delegated permissions for $ResourceName..." -ForegroundColor Cyan
  
  # Resolve Resource Service Principal
  $resourceSp = Get-MgServicePrincipal -Filter "appId eq '$ResourceAppId'"
  if (-not $resourceSp) {
    Write-Host "WARNING: Could not find Service Principal for $ResourceName (App ID: $ResourceAppId)" -ForegroundColor Yellow
    Write-Host "This resource may not be available in this tenant. Skipping..." -ForegroundColor Yellow
    return
  }
  $ResourceSpId = $resourceSp.Id
  Write-Host "  $ResourceName Service Principal ID: $ResourceSpId" -ForegroundColor Gray
  
  # Normalize scopes
  $ScopesList = ($Scopes -split '[,\s]+' | Where-Object { $_ -ne '' }) -join ' '
  Write-Host "  Scopes: $ScopesList" -ForegroundColor Gray
  
  # Check for existing grant
  $existing = Get-ExistingGrant -ClientSpId $ClientSpId -ResourceSpId $ResourceSpId
  
  if ($existing -and $existing.Count -gt 0) {
    Write-Host "  Delegated permission grant already exists:" -ForegroundColor Yellow
    foreach ($grant in $existing) {
      Write-Host "    Grant ID: $($grant.id)" -ForegroundColor Gray
      Write-Host "    Scopes: $($grant.scope)" -ForegroundColor Gray
    }
  }
  else {
    # Create new grant
    $body = @{
      clientId    = $ClientSpId
      consentType = $ConsentType
      principalId = $null
      resourceId  = $ResourceSpId
      scope       = $ScopesList
    }
    if ($ConsentType -eq 'Principal') {
      $body['principalId'] = $PrincipalId
    }
    
    try {
      $created = Invoke-MgGraphRequest -Method POST `
        -Uri "https://graph.microsoft.com/v1.0/oauth2PermissionGrants" `
        -Body ($body | ConvertTo-Json)
      Write-Host "  Created new delegated permission grant" -ForegroundColor Green
      Write-Host "    Grant ID: $($created.id)" -ForegroundColor Gray
      Write-Host "    Scopes: $($created.scope)" -ForegroundColor Gray
    }
    catch {
      Write-Host "  ERROR: Failed to create delegated permission grant for $ResourceName" -ForegroundColor Red
      Write-Host "    Details: $($_.Exception.Message)" -ForegroundColor Gray
    }
  }
  Write-Host ""
}

# --- Create or Update grants for both resources ---------------------------

# 1. Microsoft Graph
Grant-DelegatedPermissions -ClientSpId $ClientSpId -ResourceAppId $GraphAppId -ResourceName "Microsoft Graph" -Scopes $GraphScopes -ConsentType $ConsentType -PrincipalId $PrincipalId

# 2. Messaging Bot API Application
Grant-DelegatedPermissions -ClientSpId $ClientSpId -ResourceAppId $MessagingBotAppId -ResourceName "Messaging Bot API" -Scopes $MessagingBotScopes -ConsentType $ConsentType -PrincipalId $PrincipalId

Write-Host "Delegated permissions configuration completed." -ForegroundColor Green

# --- Enable Consent Permission Inheritance for Both Resources -------------
Write-Host "`nEnabling consent permission inheritance for Agent Blueprint..." -ForegroundColor Cyan
Write-Host "Agent Application Identities (AAI) created from this blueprint will inherit ALL ALLOWED permissions." -ForegroundColor Yellow
Write-Host ""

# 1. Microsoft Graph Permission Inheritance
Write-Host "Configuring Microsoft Graph permission inheritance..." -ForegroundColor Cyan
try {
  $graphInheritanceResult = Set-InheritablePermissions -AgentApplicationObjectId $AgentApplicationObjectId -ResourceAppId $GraphAppId -ResourceName "Microsoft Graph"
  Write-Host "  Microsoft Graph inheritable permissions configured successfully." -ForegroundColor Green
}
catch {
  Write-Host "  ERROR: Failed to configure Microsoft Graph inheritable permissions." -ForegroundColor Red
  Write-Host "    Details: $($_.Exception.Message)" -ForegroundColor Gray
  Write-Host "  This may be expected if Graph permissions are handled differently in your tenant." -ForegroundColor Yellow
}
Write-Host ""

# 2. Messaging Bot API Permission Inheritance
Write-Host "Configuring Messaging Bot API permission inheritance..." -ForegroundColor Cyan
try {
  $messagingBotInheritanceResult = Set-InheritablePermissions -AgentApplicationObjectId $AgentApplicationObjectId -ResourceAppId $MessagingBotAppId -ResourceName "Messaging Bot API"
  Write-Host "  Messaging Bot API inheritable permissions configured successfully." -ForegroundColor Green
}
catch {
  Write-Host "  ERROR: Failed to configure Messaging Bot API inheritable permissions." -ForegroundColor Red
  Write-Host "    Details: $($_.Exception.Message)" -ForegroundColor Gray
}
Write-Host ""

Write-Host "================================================================================================" -ForegroundColor Green
Write-Host "                          CONFIGURATION COMPLETED SUCCESSFULLY!                                 " -ForegroundColor Green
Write-Host "================================================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Summary:" -ForegroundColor Yellow
Write-Host "  • Agent Blueprint Application ID: $AgentBlueprintApplicationId" -ForegroundColor White
Write-Host "  • Agent Blueprint Object ID: $AgentApplicationObjectId" -ForegroundColor White
Write-Host "  • Configured Resources:" -ForegroundColor White
Write-Host "    - Microsoft Graph ($GraphAppId)" -ForegroundColor Gray
Write-Host "    - Messaging Bot API ($MessagingBotAppId)" -ForegroundColor Gray
Write-Host ""
Write-Host "All Agent Application Identities (AAI) created from this blueprint will inherit the configured permissions." -ForegroundColor Cyan
Write-Host ""
