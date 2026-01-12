# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

#Requires -Modules Az.Accounts, Az.Resources, Microsoft.Graph.Authentication

<#
.SYNOPSIS
    Provisions Azure resources and agent blueprint for Perplexity agent
    
.DESCRIPTION
    This script provisions the Perplexity Agent by executing the necessary setup commands.
    It's mostly useful for provisioning on a new tenant.
    
.PARAMETER ConfigFilePath
    Path to the YAML configuration file containing tenant and agent settings
    
.EXAMPLE
    .\provisionAgent.ps1 -ConfigFilePath ".\config.yml"
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$ConfigFilePath
)

# ============================================================================
# FUNCTIONS
# ============================================================================

function Read-ConfigFile {
    <#
    .SYNOPSIS
        Reads and parses the configuration file
    #>
    param([string]$Path)
    
    if (-not (Test-Path $Path)) {
        throw "Config file not found: $Path"
    }
    
    # Install powershell-yaml if needed for YAML parsing
    # Version pinned to 0.4.12 from PSGallery for supply-chain security
    # This prevents automatic installation of potentially compromised future versions
    if (-not (Get-Module -ListAvailable -Name powershell-yaml)) {
        Write-Host "Installing powershell-yaml module (v0.4.12)..." -ForegroundColor Yellow
        Install-Module -Name powershell-yaml -RequiredVersion 0.4.12 -Repository PSGallery -Scope CurrentUser -Force
    }
    
    Import-Module powershell-yaml
    $config = Get-Content $Path -Raw | ConvertFrom-Yaml
    return $config
}

function Connect-AzureAndGraph {
    <#
    .SYNOPSIS
        Establishes fresh connection to Azure and connects to Microsoft Graph (reusing existing Graph session when appropriate)
    #>
    param(
        [string]$TenantId
    )
    
    Write-Host "Connecting to Azure and Microsoft Graph..." -ForegroundColor Cyan
    
    # Always clear and reconnect to Azure to ensure fresh credentials
    try {
        # Disconnect any existing Azure context to force fresh login
        $null = Disconnect-AzAccount -ErrorAction SilentlyContinue
        
        Write-Host "  Connecting to Azure..." -ForegroundColor Gray
        $azContext = Connect-AzAccount -TenantId $TenantId
        
        if ($azContext) {
            Write-Host "  ✓ Connected to Azure (Subscription: $($azContext.Context.Subscription.Name))" -ForegroundColor Green
        }
    }
    catch {
        Write-Error "Failed to connect to Azure: $_"
        throw
    }
    
    # Connect to Microsoft Graph (only prompts if not already connected with required scopes)
    $requiredScopes = @(
        "AgentIdentityBlueprint.Create",
        "AgentIdentityBlueprint.ReadWrite.All",
        "Application.ReadWrite.All",
        "AgentIdentityBlueprintPrincipal.Create",
        "AppRoleAssignment.ReadWrite.All",
        "Directory.Read.All"
    )
    
    $mgContext = Get-MgContext
    if (-not $mgContext -or $mgContext.TenantId -ne $TenantId) {
        Connect-MgGraph -Scopes $requiredScopes -TenantId $TenantId -NoWelcome
    } else {
        Write-Host "  Already connected to Microsoft Graph" -ForegroundColor Gray
    }
    
    Write-Host "✓ Connected successfully" -ForegroundColor Green
}

function New-AzureResourceGroup {
    <#
    .SYNOPSIS
        Creates an Azure resource group (idempotent)
    #>
    param(
        [string]$Name,
        [string]$Location
    )
    
    Write-Host "`nCreating resource group: $Name in $Location" -ForegroundColor Cyan
    
    try {
        # Check if exists first (idempotent)
        $rg = Get-AzResourceGroup -Name $Name -ErrorAction SilentlyContinue
        
        if ($rg) {
            Write-Host "✓ Resource group already exists" -ForegroundColor Yellow
            return $rg
        }
        
        $rg = New-AzResourceGroup -Name $Name -Location $Location -Force -ErrorAction Stop
        Write-Host "✓ Resource group created: $($rg.ResourceGroupName)" -ForegroundColor Green
        
        return $rg
    }
    catch {
        Write-Error "Failed to create resource group: $_"
        throw
    }
}

function Get-CurrentUserObjectId {
    <#
    .SYNOPSIS
        Gets the current user's object ID from Microsoft Graph
    #>
    
    Write-Host "Getting current user object ID..." -ForegroundColor Cyan
    
    try {
        $currentUser = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/me"
        Write-Host "✓ Current user: $($currentUser.displayName) ($($currentUser.userPrincipalName))" -ForegroundColor Green
        Write-Host "  Object ID: $($currentUser.id)" -ForegroundColor Cyan
        return $currentUser.id  # Returns user object ID
    }
    catch {
        Write-Error "Failed to get current user ID: $_"
        throw
    }
}

function New-AgentBlueprint {
    <#
    .SYNOPSIS
        Creates an agentic blueprint
    #>
    param(
        [string]$AgentName,
        [string]$SponsorUserId
    )
    
    Write-Host "`nCreating agentic blueprint: $AgentName" -ForegroundColor Cyan
    
    $body = @{
        "@odata.type" = "Microsoft.Graph.AgentIdentityBlueprint"
        displayName = "$AgentName Agent Blueprint"
        "sponsors@odata.bind" = @("https://graph.microsoft.com/v1.0/users/$SponsorUserId")
    }
    
    try {
        $blueprint = Invoke-MgGraphRequest -Method POST `
            -Uri "https://graph.microsoft.com/beta/applications/" `
            -Headers @{ "OData-Version" = "4.0" } `
            -Body ($body | ConvertTo-Json)
        
        Write-Host "✓ Blueprint created" -ForegroundColor Green
        Write-Host "  App ID: $($blueprint.appId)" -ForegroundColor Cyan
        Write-Host "  Object ID: $($blueprint.id)" -ForegroundColor Cyan
        
        return @{
            AppId = $blueprint.appId
            ObjectId = $blueprint.id
            Blueprint = $blueprint
        }
    }
    catch {
        Write-Error "Failed to create blueprint: $_"
        throw
    }
}

function Save-ProvisionState {
    <#
    .SYNOPSIS
        Saves provisioning state to a JSON file for use in subsequent steps
    #>
    param(
        [hashtable]$State,
        [string]$OutputPath = "provision-state.json"
    )
    
    Write-Host "`nSaving provisioning state to: $OutputPath" -ForegroundColor Cyan
    $State | ConvertTo-Json -Depth 10 | Out-File $OutputPath -Force
    Write-Host "✓ State saved" -ForegroundColor Green
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================

try {
    Write-Host ""
    Write-Host "=======================================" -ForegroundColor Cyan
    Write-Host "  Agent Provisioning Script" -ForegroundColor Cyan
    Write-Host "=======================================" -ForegroundColor Cyan
    Write-Host ""
    
    # 1. Read configuration
    Write-Host "Reading configuration from: $ConfigFilePath" -ForegroundColor Cyan
    $config = Read-ConfigFile -Path $ConfigFilePath
    Write-Host "✓ Configuration loaded" -ForegroundColor Green
    
    # 2. Authenticate (only prompts once per session)
    Connect-AzureAndGraph -TenantId $config.tenant_id
    
    # 3. Get current user object ID (dynamically)
    $currentUserId = Get-CurrentUserObjectId
    
    # 4. Create resource group (auto-generate name from agent name)
    $resourceGroupName = "rg-$($config.agent_name)"
    $resourceGroup = New-AzureResourceGroup -Name $resourceGroupName -Location $config.region
    
    # 5. Create agent blueprint (auto-generate display name from agent name)
    $blueprint = New-AgentBlueprint -AgentName $config.agent_name -SponsorUserId $currentUserId
    
    # 6. Save state for next steps
    $state = @{
        Timestamp = Get-Date -Format "o"
        Config = $config
        ResourceGroup = @{
            Name = $resourceGroup.ResourceGroupName
            Location = $resourceGroup.Location
            Id = $resourceGroup.ResourceId
        }
        Blueprint = @{
            AppId = $blueprint.AppId
            ObjectId = $blueprint.ObjectId
        }
    }
    
    Save-ProvisionState -State $state
    
    Write-Host ""
    Write-Host "=======================================" -ForegroundColor Green
    Write-Host "  Provisioning Complete!" -ForegroundColor Green
    Write-Host "=======================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Yellow
    Write-Host "  1. Review provision-state.json" -ForegroundColor Gray
    Write-Host "  2. Run service principal creation script" -ForegroundColor Gray
    Write-Host ""
    
    return $state
}
catch {
    Write-Host ""
    Write-Host "=======================================" -ForegroundColor Red
    Write-Host "  Provisioning Failed" -ForegroundColor Red
    Write-Host "=======================================" -ForegroundColor Red
    Write-Error "Error: $_"
    exit 1
}

