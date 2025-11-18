# Parameters
param(
    [Parameter(Mandatory=$false)]
    [string]$ConfigFile,
    
    [Parameter(Mandatory=$false)]
    [string]$OutputJsonPath
)

# Function to read configuration from JSON file
function Read-ConfigFile {
    param(
        [Parameter(Mandatory=$true)]
        [string]$ConfigFilePath
    )
    
    if (-not (Test-Path $ConfigFilePath)) {
        Write-Host "ERROR: Config file not found: $ConfigFilePath" -ForegroundColor Red
        exit 1
    }
    
    try {
        $configContent = Get-Content $ConfigFilePath -Raw | ConvertFrom-Json
        
        # Validate required properties
        if (-not $configContent.TenantId) {
            Write-Host "ERROR: Config file is missing 'TenantId' property" -ForegroundColor Red
            exit 1
        }
        
        # Support both MsiPrincipalId and ManagedIdentityId for flexibility
        $msiId = $null
        if ($configContent.MsiPrincipalId) {
            $msiId = $configContent.MsiPrincipalId
        } elseif ($configContent.ManagedIdentityId) {
            $msiId = $configContent.ManagedIdentityId
        }
        
        if (-not $msiId) {
            Write-Host "ERROR: Config file is missing 'MsiPrincipalId' or 'ManagedIdentityId' property" -ForegroundColor Red
            exit 1
        }
        
        # Add the standardized property to the config object
        $configContent | Add-Member -NotePropertyName "MsiPrincipalId" -NotePropertyValue $msiId -Force
        
        return $configContent
    } catch {
        Write-Host "ERROR: Failed to parse config file: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}

# Function to create Agent Blueprint
function createAgentBlueprint {
    param(
        [Parameter(Mandatory=$true)]
        [string]$TenantId,
        
        [Parameter(Mandatory=$true)]
        [string]$DisplayName
    )

    try {
        
        $currentUser = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/me"
        Write-Host "Current user: $($currentUser.DisplayName) <$($currentUser.UserPrincipalName)>" -ForegroundColor Gray
        Write-Host "Sponsor details: "https://graph.microsoft.com/v1.0/users/$($currentUser.Id)" -ForegroundColor Gray"
    
        $body = @{
            "@odata.type" = "Microsoft.Graph.AgentIdentityBlueprint"
            displayName   = $DisplayName
            "sponsors@odata.bind" = @("https://graph.microsoft.com/v1.0/users/$($currentUser.Id)")
        }
        $response = Invoke-MgGraphRequest -Method POST `
                -Uri "https://graph.microsoft.com/beta/applications/" `
                -Headers @{ "OData-Version" = "4.0" } `
                -Body ($body | ConvertTo-Json)
    }
    catch {
        
        if ($_.Exception.Response.StatusCode.value__ -eq 400)
        {
            Write-Host "Agent Blueprint creation failed with Bad Request (400). Fallback to call without sponsor request..."

            $body = @{
                "@odata.type" = "Microsoft.Graph.AgentIdentityBlueprint"
                displayName   = $DisplayName
            }
            $fallbackResponse = Invoke-MgGraphRequest -Method POST `
                    -Uri "https://graph.microsoft.com/beta/applications/" `
                    -Headers @{ "OData-Version" = "4.0" } `
                    -Body ($body | ConvertTo-Json)

            return $fallbackResponse
        }
    }
    return $response       
}

# Function to create Service Principal
function createServicePrincipal {
    param(
        [Parameter(Mandatory=$true)]
        [string]$TenantId,
        
        [Parameter(Mandatory=$true)]
        [string]$AppId
    )
    
    $body = @{
        appId = $AppId
    }
    #this is a workaround needed until the serviceprincipals/graph.agentServicePrincipal is supported in the new tenants.
    $response = Invoke-MgGraphRequest -Method POST `
            -Uri "https://graph.microsoft.com/beta/serviceprincipals" `
            -Headers @{ "OData-Version" = "4.0" } `
            -Body ($body | ConvertTo-Json)
    
    return $response
}

# Function to create Federated Identity Credential
function createFederatedIdentityCredential {
    param(
        [Parameter(Mandatory=$true)]
        [string]$TenantId,
        
        [Parameter(Mandatory=$true)]
        [string]$AgentBlueprintObjectId,

        [Parameter(Mandatory=$true)]
        [string]$CredentialName,
        
        [Parameter(Mandatory=$true)]
        [string]$MsiPrincipalId
    )
    
    $federatedCredential = @{
        Name      = $CredentialName
        Issuer    = "https://login.microsoftonline.com/$TenantId/v2.0"
        Subject   = $MsiPrincipalId
        Audiences = @("api://AzureADTokenExchange")
    }
    
    $response = New-MgApplicationFederatedIdentityCredential `
        -ApplicationId $AgentBlueprintObjectId `
        -BodyParameter $federatedCredential
    
    return $response
}

# Function to read MCP scopes from ToolingManifest.json
function Get-McpScopesFromManifest {
    param(
        [Parameter(Mandatory=$false)]
        [string]$ManifestPath
    )
    
    $mcpScopes = @()
    
    if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
        # Default path - look for ToolingManifest.json in the script directory
        $defaultManifestPath = Join-Path $PSScriptRoot "ToolingManifest.json"
        if (Test-Path $defaultManifestPath) {
            $ManifestPath = $defaultManifestPath
        } else {
            Write-Host "INFO: No ToolingManifest.json found at $defaultManifestPath, skipping MCP scopes" -ForegroundColor Yellow
            return $mcpScopes
        }
    }
    
    if (-not (Test-Path $ManifestPath)) {
        Write-Host "INFO: ToolingManifest.json not found at $ManifestPath, skipping MCP scopes" -ForegroundColor Yellow
        return $mcpScopes
    }
    
    try {
        Write-Host "Reading MCP scopes from: $ManifestPath" -ForegroundColor Cyan
        $manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
        
        if ($manifest.mcpServers -and $manifest.mcpServers.Count -gt 0) {
            foreach ($server in $manifest.mcpServers) {
                # Support both 'scope' (new CLI format) and 'requiredScopes' (legacy) properties
                if ($server.scope -and -not [string]::IsNullOrWhiteSpace($server.scope)) {
                    if ($mcpScopes -notcontains $server.scope) {
                        $mcpScopes += $server.scope
                        Write-Host "  Found MCP scope: $server.scope (from mcpServerName: $($server.mcpServerName))" -ForegroundColor Green
                    }
                }
                elseif ($server.requiredScopes -and $server.requiredScopes.Count -gt 0) {
                    foreach ($scope in $server.requiredScopes) {
                        if (-not [string]::IsNullOrWhiteSpace($scope) -and $mcpScopes -notcontains $scope) {
                            $mcpScopes += $scope
                            Write-Host "  Found MCP scope: $scope (legacy requiredScopes)" -ForegroundColor Green
                        }
                    }
                }
            }
        }
        
        if ($mcpScopes.Count -gt 0) {
            Write-Host "Total MCP scopes found: $($mcpScopes.Count)" -ForegroundColor Cyan
        } else {
            Write-Host "No MCP scopes found in manifest" -ForegroundColor Yellow
        }
        
    } catch {
        Write-Host "WARNING: Failed to read ToolingManifest.json: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "Continuing without MCP scopes..." -ForegroundColor Yellow
    }
    
    return $mcpScopes
}

# Function to configure Agent Blueprint Scope
function configureAgentBlueprintScope {
    param(
        [Parameter(Mandatory=$true)]
        [string]$TenantId,
        
        [Parameter(Mandatory=$true)]
        [string]$AgentBlueprintObjectId,
        
        [Parameter(Mandatory=$true)]
        [string]$AgentBlueprintId,
        
        [Parameter(Mandatory=$false)]
        [string]$ToolingManifestPath
    )

    $IdentifierUri = "api://$AgentBlueprintId"
    
    # Start with the default access_agent scope
    $scopes = @()
    
    # Add default agent access scope
    $defaultScopeId = [guid]::NewGuid()
    $defaultScope = @{
        adminConsentDescription = "Allow the application to access the agent on behalf of the signed-in user."
        adminConsentDisplayName = "Access agent"
        id = $defaultScopeId
        isEnabled = $true
        type = "User"
        value = "access_agent"
    }
    $scopes += $defaultScope
    
    # Read and add MCP scopes from ToolingManifest.json
    $mcpScopes = Get-McpScopesFromManifest -ManifestPath $ToolingManifestPath
    
    foreach ($mcpScope in $mcpScopes) {
        $mcpScopeId = [guid]::NewGuid()
        $mcpScopeObj = @{
            adminConsentDescription = "Allow the application to access MCP server requiring scope: $mcpScope"
            adminConsentDisplayName = "MCP Access: $mcpScope"
            id = $mcpScopeId
            isEnabled = $true
            type = "User"
            value = $mcpScope
        }
        $scopes += $mcpScopeObj
        Write-Host "Added MCP scope to blueprint: $mcpScope" -ForegroundColor Green
    }
    
    Write-Host "Configuring blueprint with $($scopes.Count) OAuth2 permission scopes" -ForegroundColor Cyan

    $response = Update-MgApplication -ApplicationId $AgentBlueprintObjectId `
        -IdentifierUris @($IdentifierUri) `
        -Api @{ oauth2PermissionScopes = $scopes }
    
    return $response
}

# Helper: get service principal (object) id for a given appId in this tenant
function Get-ServicePrincipalObjectIdByAppId {
    param(
        [Parameter(Mandatory=$true)]
        [string]$AppId
    )

    if ([string]::IsNullOrWhiteSpace($AppId)) {
        throw "AppId must be provided"
    }

    try {
        # Use the SDK cmdlet to find the service principal in this tenant
        $sp = Get-MgServicePrincipal -Filter "appId eq '$AppId'"

        if (-not $sp -or ($sp -is [System.Array] -and $sp.Count -eq 0)) {
            throw "No servicePrincipal found for appId '$AppId' in this tenant."
        }

        # If multiple returned, pick the first
        $servicePrincipal = $sp
        if ($sp -is [System.Array]) { $servicePrincipal = $sp[0] }

        return $servicePrincipal.Id
    } catch {
        Write-Host "ERROR: Failed to retrieve service principal for appId '$AppId'." -ForegroundColor Red
        Write-Host "   Details: $($_.Exception.Message)" -ForegroundColor Gray
        throw
    }
}

#Function to grant admin consent for specified Microsoft Graph scopes
function grantGraphScopeConsent {
    param(
        [Parameter(Mandatory=$true)]
        [string]$TenantId,

        [Parameter(Mandatory=$true)]
        [string]$ServicePrincipalId,

        [Parameter(Mandatory=$true)]
        [string]$Scopes # List of scopes, e.g., "User.Read Directory.Read.All"
    )

    # Well-known Microsoft Graph application id (appId). We'll resolve its service principal (object id) in this tenant.
    $GraphAppId = "00000003-0000-0000-c000-000000000000"

    try {
        $GraphServicePrincipalId = Get-ServicePrincipalObjectIdByAppId -AppId $GraphAppId
        Write-Host "Found Microsoft Graph service principal in this tenant: $GraphServicePrincipalId" -ForegroundColor Gray
    } catch {
        Write-Host "ERROR: Unable to determine Microsoft Graph service principal in this tenant." -ForegroundColor Red
        Write-Host "   Details: $($_.Exception.Message)" -ForegroundColor Gray
        exit 1
    }

    $body = @{
        clientId     = $ServicePrincipalId
        consentType  = "AllPrincipals"
        principalId  = $null
        resourceId   = $GraphServicePrincipalId
        scope        = $Scopes
    }

    try {
        $response = Invoke-MgGraphRequest -Method POST `
            -Uri "https://graph.microsoft.com/v1.0/oauth2PermissionGrants" `
            -Body ($body | ConvertTo-Json)
        Write-Host "Admin consent granted for scope '$Scopes'." -ForegroundColor Green
    } catch {
        Write-Host "ERROR: Failed to grant admin consent for scope '$Scopes'." -ForegroundColor Red
        Write-Host "   Details: $($_.Exception.Message) $($_.Exception.InnerException.Message) " -ForegroundColor Gray
        exit 1
    }
}

function addInheritablePermissionsForAgentIdentities {
    param(
        [Parameter(Mandatory=$true)]
        [string]$AgentBlueprintObjectId,

        [Parameter(Mandatory=$true)]
        [string]$ResourceAppId, # e.g., "00000003-0000-0000-c000-000000000000" for Graph

        [Parameter(Mandatory=$true)]
        [string[]]$Scopes # Array of scopes, e.g., @("User.Read", "Mail.Send")
    )

    $body = @{
        resourceAppId = $ResourceAppId
        inheritableScopes = @{
            "@odata.type" = "microsoft.graph.enumeratedScopes"
            scopes = $Scopes
        }
    }

    try {
        $response = Invoke-MgGraphRequest -Method POST `
            -Uri "https://graph.microsoft.com/beta/applications/microsoft.graph.agentIdentityBlueprint/$AgentBlueprintObjectId/inheritablePermissions" `
            -Body ($body | ConvertTo-Json)
        Write-Host "Inheritable permissions added for agent identities." -ForegroundColor Green
        return $response
    } catch {
        Write-Host "ERROR: Failed to add inheritable permissions for agent identities." -ForegroundColor Red
        Write-Host "   Details: $($_.Exception.Message)" -ForegroundColor Gray
        exit 1
    }
}


# Display script header
Write-Host ""
Write-Host "================================================================================================" -ForegroundColor Cyan
Write-Host "                            Agent Blueprint Creation Script                                     " -ForegroundColor Cyan
Write-Host "================================================================================================" -ForegroundColor Cyan
Write-Host ""

# Initialize variables
$TenantId = $null
$MsiPrincipalId = $null
$DisplayName = $null

# Check if config file is provided
if ($ConfigFile) {
    Write-Host "Reading configuration from file: $ConfigFile" -ForegroundColor Yellow
    $config = Read-ConfigFile -ConfigFilePath $ConfigFile
    $TenantId = $config.TenantId
    $MsiPrincipalId = $config.MsiPrincipalId
    
    # Read DisplayName from config
    $DisplayName = $config.AgentBlueprintDisplayName
    
    Write-Host "Configuration loaded successfully!" -ForegroundColor Green
    Write-Host "  • Tenant ID: $TenantId" -ForegroundColor Gray
    Write-Host "  • MSI Principal ID: $MsiPrincipalId" -ForegroundColor Gray
    if ($DisplayName) {
        Write-Host "  • Display Name: $DisplayName" -ForegroundColor Gray
    }
    Write-Host ""
} else {
    # Prompt user for input when config file is not provided
    Write-Host "Please provide the following information:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Tenant ID: " -ForegroundColor Yellow -NoNewline
    $TenantId = Read-Host
    
    Write-Host ""
    Write-Host "Object (Principal) ID of the managed identity (optional - provide if you have an app service ready): " -ForegroundColor Yellow -NoNewline
    $MsiPrincipalId = Read-Host
}

Write-Host ""

try {
    Connect-AzAccount -TenantId $TenantId
    Connect-MgGraph -TenantId $TenantId
} catch {
    Write-Host "ERROR: Failed to connect to Microsoft Graph. Please ensure you have the Microsoft Graph PowerShell SDK installed and try again." -ForegroundColor Red
    exit 1
}

# Validate that TenantId is not empty
if ([string]::IsNullOrWhiteSpace($TenantId) -or -not ($TenantId -match '^[0-9a-fA-F-]{36}$')) {
    Write-Host "ERROR: Invalid Tenant ID format. Please provide a valid GUID." -ForegroundColor Red
    Write-Host "   Expected format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" -ForegroundColor Gray
    exit 1
}

# Validate MSI Principal ID
if ($MsiPrincipalId -and -not ($MsiPrincipalId -match '^[0-9a-fA-F-]{36}$')) {
    Write-Host "ERROR: Invalid Object (Principal) ID format. Please provide a valid GUID." -ForegroundColor Red
    Write-Host "   Expected format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" -ForegroundColor Gray
    exit 1
}

# Prompt user for Display Name only if not provided in config
if ([string]::IsNullOrWhiteSpace($DisplayName)) {
    Write-Host "Display Name for the Agent Application: " -ForegroundColor Yellow -NoNewline
    $DisplayName = Read-Host
    
    if ([string]::IsNullOrWhiteSpace($DisplayName)) {
        Write-Host "ERROR: Display Name cannot be empty." -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "Configuration Summary:" -ForegroundColor Blue
Write-Host "  • Tenant ID: $TenantId" -ForegroundColor Gray
Write-Host "  • MSI Principal ID: $MsiPrincipalId" -ForegroundColor Gray
Write-Host "  • Display Name: $DisplayName" -ForegroundColor Gray
Write-Host ""

Write-Host "Starting Agent Blueprint creation..." -ForegroundColor Blue
Write-Host "------------------------------------------------------------------------------------------------" -ForegroundColor Gray

# 1. Create Agent Blueprint
Write-Host ""
Write-Host "Step 1/6: Creating Agent Blueprint..." -ForegroundColor Yellow
try {
    $agentBlueprint = createAgentBlueprint -TenantId $TenantId -DisplayName $DisplayName
    Write-Host "Agent Blueprint created successfully!" -ForegroundColor Green
    Write-Host "   App ID: $($agentBlueprint.appId)" -ForegroundColor Cyan
    Write-Host "   Object ID: $($agentBlueprint.id)" -ForegroundColor Cyan
} catch {
    Write-Host "ERROR: Failed to create Agent Blueprint" -ForegroundColor Red
    Write-Host "   Details: $($_.Exception.Message)" -ForegroundColor Gray
    exit 1
}

# 2. Create Service Principal for the Agent Blueprint
Write-Host ""
Write-Host "Step 2/6: Creating Service Principal..." -ForegroundColor Yellow
try {
    $servicePrincipal = createServicePrincipal -TenantId $TenantId -AppId $agentBlueprint.appId
    Write-Host "Service Principal created successfully!" -ForegroundColor Green
    Write-Host "   App ID: $($servicePrincipal.appId)" -ForegroundColor Cyan
    Write-Host "   Object ID: $($servicePrincipal.id)" -ForegroundColor Cyan
} catch {
    Write-Host "ERROR: Failed to create Service Principal" -ForegroundColor Red
    Write-Host "   Details: $($_.Exception.Message)" -ForegroundColor Gray
    exit 1
}

Write-Host "Waiting 10 seconds to ensure Service Principal is fully propagated..." -ForegroundColor Gray
Start-Sleep -Seconds 10

# 3. Create Federated Identity Credential
Write-Host ""
if ($MsiPrincipalId) {
Write-Host "Step 3/6: Creating Federated Identity Credential..." -ForegroundColor Yellow
$CredentialName = "$($DisplayName -replace '\s+', '')-MSI"

    try {
        $federatedCredential = createFederatedIdentityCredential -TenantId $TenantId -AgentBlueprintObjectId $agentBlueprint.id -CredentialName $CredentialName -MsiPrincipalId $MsiPrincipalId
        Write-Host "Federated Identity Credential created successfully!" -ForegroundColor Green
        Write-Host "   Credential Name: $DisplayName-MSI" -ForegroundColor Cyan
    } catch {
        Write-Host "ERROR: Failed to create Federated Identity Credential" -ForegroundColor Red
        Write-Host "   Details: $($_.Exception.Message)" -ForegroundColor Gray
        exit 1
    }
} else {
    Write-Host "Skipping Step 3/6 (Federated Identity Credential creation): MSI Principal ID is not provided." -ForegroundColor Yellow
}


# 4. Configure Agent Blueprint Scope
Write-Host ""
Write-Host "Step 4/6: Configuring Agent Blueprint Scope..." -ForegroundColor Yellow
try {
    # Look for ToolingManifest.json in the deployment project path if available, otherwise script directory
    $toolingManifestPath = $null
    if ($ConfigFile -and $config.deploymentProjectPath) {
        $toolingManifestPath = Join-Path $config.deploymentProjectPath "ToolingManifest.json"
        Write-Host "Looking for ToolingManifest.json in deployment project path: $toolingManifestPath" -ForegroundColor Gray
    } else {
        $toolingManifestPath = Join-Path $PSScriptRoot "ToolingManifest.json"
        Write-Host "Looking for ToolingManifest.json in script directory: $toolingManifestPath" -ForegroundColor Gray
    }
    
    $configuredApp = configureAgentBlueprintScope -TenantId $TenantId -AgentBlueprintObjectId $agentBlueprint.id -AgentBlueprintId $agentBlueprint.appId -ToolingManifestPath $toolingManifestPath
    Write-Host "Agent Blueprint scope configured successfully!" -ForegroundColor Green
    Write-Host "   Identifier URI: api://$($agentBlueprint.appId)" -ForegroundColor Cyan
    Write-Host "   Default scope: access_agent" -ForegroundColor Cyan
} catch {
    Write-Host "ERROR: Failed to configure Agent Blueprint scope" -ForegroundColor Red
    Write-Host "   Details: $($_.Exception.Message)" -ForegroundColor Gray
    exit 1
}

# 5. Grant Agent Blueprint consent to required graph scopes
$scopes = "Chat.ReadWrite Files.Read.All Mail.ReadWrite Mail.Send Sites.Read.All User.Read.All"

Write-Host ""
Write-Host "Step 5/6: Granting Admin Consent for Graph Scopes..." -ForegroundColor Yellow
try {
    grantGraphScopeConsent -TenantId $TenantId -ServicePrincipalId $servicePrincipal.id -Scopes $scopes
} catch {
    Write-Host "ERROR: Failed to grant admin consent for Graph scopes" -ForegroundColor Red
    Write-Host "   Details: $($_.Exception.Message)" -ForegroundColor Gray
    exit 1
}

# 6. Add inheritable perms for these scopes for agent identities created using this agent blueprint.
Write-Host ""
Write-Host "Step 6/6: Adding Inheritable Permissions for Agent Identities..." -ForegroundColor Yellow
try {
    addInheritablePermissionsForAgentIdentities -AgentBlueprintObjectId $agentBlueprint.id -ResourceAppId "00000003-0000-0000-c000-000000000000" -Scopes $scopes
} catch {
    Write-Host "ERROR: Failed to add inheritable permissions for agent identities" -ForegroundColor Red
    Write-Host "   Details: $($_.Exception.Message)" -ForegroundColor Gray
    exit 1
}

Write-Host ""
Write-Host "================================================================================================" -ForegroundColor Green
Write-Host "                                 INSTALLATION COMPLETED SUCCESSFULLY!                           " -ForegroundColor Green
Write-Host "================================================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Agent Blueprint Details:" -ForegroundColor Yellow
Write-Host "  • Display Name: $DisplayName" -ForegroundColor White
Write-Host "  • App ID: $($agentBlueprint.appId)" -ForegroundColor White
Write-Host "  • Object ID: $($agentBlueprint.id)" -ForegroundColor White
Write-Host "  • Service Principal ID: $($servicePrincipal.id)" -ForegroundColor White
Write-Host "  • Identifier URI: api://$($agentBlueprint.appId)" -ForegroundColor White

# Write output to JSON file if OutputJsonPath is provided
if ($OutputJsonPath) {
    Write-Host ""
    Write-Host "Writing output to: $OutputJsonPath" -ForegroundColor Cyan
    
    $outputData = @{
        AgentBlueprintId = $agentBlueprint.appId
        AgentBlueprintObjectId = $agentBlueprint.id
        DisplayName = $DisplayName
        ServicePrincipalId = $servicePrincipal.id
        IdentifierUri = "api://$($agentBlueprint.appId)"
        TenantId = $TenantId
    }
    
    $outputData | ConvertTo-Json -Depth 10 | Set-Content -Path $OutputJsonPath -Encoding UTF8
    Write-Host "Output written successfully" -ForegroundColor Green
}
