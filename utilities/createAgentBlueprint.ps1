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
    
    # Use beta endpoint for Federated Identity Credential creation
    $response = Invoke-MgGraphRequest -Method POST `
        -Uri "https://graph.microsoft.com/beta/applications/$AgentBlueprintObjectId/federatedIdentityCredentials" `
        -Body ($federatedCredential | ConvertTo-Json)
    
    return $response
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
Write-Host "Step 1/3: Creating Agent Blueprint..." -ForegroundColor Yellow
try {
    $agentBlueprint = createAgentBlueprint -TenantId $TenantId -DisplayName $DisplayName
    Write-Host "Agent Blueprint created successfully!" -ForegroundColor Green
    Write-Host "   App ID: $($agentBlueprint.appId)" -ForegroundColor Cyan
    Write-Host "   Object ID: $($agentBlueprint.id)" -ForegroundColor Cyan
    
    # Wait for Agent Blueprint to be fully propagated before proceeding
    Write-Host "Waiting 15 seconds to ensure Agent Blueprint is fully propagated..." -ForegroundColor Gray
    Start-Sleep -Seconds 15
} catch {
    Write-Host "ERROR: Failed to create Agent Blueprint" -ForegroundColor Red
    Write-Host "   Details: $($_.Exception.Message)" -ForegroundColor Gray
    exit 1
}

# 2. Create Service Principal for the Agent Blueprint
Write-Host ""
Write-Host "Step 2/3: Creating Service Principal..." -ForegroundColor Yellow
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
Write-Host "Step 3/3: Creating Federated Identity Credential..." -ForegroundColor Yellow
$CredentialName = "$($DisplayName -replace '\s+', '')-MSI"

    try {
        $federatedCredential = createFederatedIdentityCredential -TenantId $TenantId -AgentBlueprintObjectId $agentBlueprint.id -CredentialName $CredentialName -MsiPrincipalId $MsiPrincipalId
        Write-Host "Federated Identity Credential created successfully!" -ForegroundColor Green
        Write-Host "   Credential Name: $CredentialName" -ForegroundColor Cyan
    } catch {
        Write-Host "ERROR: Failed to create Federated Identity Credential" -ForegroundColor Red
        Write-Host "   Details: $($_.Exception.Message)" -ForegroundColor Gray
        exit 1
    }
} else {
    Write-Host "Skipping Step 3/3 (Federated Identity Credential creation): MSI Principal ID is not provided." -ForegroundColor Yellow
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

# Write output to JSON file if OutputJsonPath is provided
if ($OutputJsonPath) {
    Write-Host ""
    Write-Host "Writing output to: $OutputJsonPath" -ForegroundColor Cyan
    
    $outputData = @{
        AgentBlueprintId = $agentBlueprint.appId
        AgentBlueprintObjectId = $agentBlueprint.id
        DisplayName = $DisplayName
        ServicePrincipalId = $servicePrincipal.id
        TenantId = $TenantId
    }
    
    $outputData | ConvertTo-Json -Depth 10 | Set-Content -Path $OutputJsonPath -Encoding UTF8
    Write-Host "Output written successfully" -ForegroundColor Green
}
