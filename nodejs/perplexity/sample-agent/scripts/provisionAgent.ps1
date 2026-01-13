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
# OUTPUT HELPERS
# ============================================================================

function Write-Info  { param([string]$Message) Write-Host "[INFO] $Message" -ForegroundColor Gray }
function Write-Step  { param([string]$Message) Write-Host "`n[STEP] $Message" -ForegroundColor Cyan }
function Write-Ok    { param([string]$Message) Write-Host "[ OK ] $Message" -ForegroundColor Green }
function Write-Warn  { param([string]$Message) Write-Host "[WARN] $Message" -ForegroundColor Yellow }
function Write-Fail  { param([string]$Message) Write-Host "[FAIL] $Message" -ForegroundColor Red }

function Get-FriendlyErrorMessage {
    param([Parameter(ValueFromPipeline=$true)]$ErrorRecord)

    try {
        $ex = $ErrorRecord.Exception
        $msg = if ($ex -and $ex.Message) { $ex.Message } else { "$ErrorRecord" }

        # Some Graph errors include useful info here:
        if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
            $msg = "$msg `nDetails: $($ErrorRecord.ErrorDetails.Message)"
        }

        return $msg
    } catch {
        return "$ErrorRecord"
    }
}

function Escape-ODataString {
    param([string]$Value)
    # OData single quotes are escaped by doubling them
    return ($Value -replace "'", "''")
}

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
    if (-not (Get-Module -ListAvailable -Name powershell-yaml)) {
        Write-Warn "powershell-yaml module not found. Installing v0.4.12 (CurrentUser)..."
        try {
            Install-Module -Name powershell-yaml -RequiredVersion 0.4.12 -Repository PSGallery -Scope CurrentUser -Force -ErrorAction Stop
        } catch {
            $msg = $_ | Get-FriendlyErrorMessage
            throw "Failed to install powershell-yaml v0.4.12. $msg"
        }
    }

    Import-Module powershell-yaml -ErrorAction Stop
    $config = Get-Content $Path -Raw | ConvertFrom-Yaml
    return $config
}

function Connect-AzureAndGraph {
    <#
    .SYNOPSIS
        Establishes fresh connection to Azure and connects to Microsoft Graph (single prompt per run)
    #>
    param(
        [string]$TenantId
    )

    Write-Step "Authenticating to Azure + Microsoft Graph"

    # -----------------------
    # Azure (fresh login)
    # -----------------------
    try {
        Write-Info "Disconnecting existing Azure context (if any)..."
        $null = Disconnect-AzAccount -ErrorAction SilentlyContinue

        Write-Info "Connecting to Azure tenant: $TenantId"
        $azContext = Connect-AzAccount -TenantId $TenantId -ErrorAction Stop

        if (-not $azContext -or -not $azContext.Context -or -not $azContext.Context.Subscription) {
            throw "Azure connection returned no subscription context. Ensure you have access to a subscription in this tenant."
        }

        Write-Ok "Connected to Azure (Subscription: $($azContext.Context.Subscription.Name))"
    }
    catch {
        $msg = $_ | Get-FriendlyErrorMessage
        throw "Failed to connect to Azure. $msg"
    }

    # -----------------------
    # Microsoft Graph (single prompt per run)
    # -----------------------
    $requiredScopes = @(
        "AgentIdentityBlueprint.Create",
        "AgentIdentityBlueprint.ReadWrite.All",
        "Application.ReadWrite.All",
        "AgentIdentityBlueprintPrincipal.Create",
        "AppRoleAssignment.ReadWrite.All",
        "Directory.Read.All"
    )

    try {
        # IMPORTANT: Start fresh each run to avoid the "prompt now + prompt again on first request" behavior.
        Write-Info "Resetting Microsoft Graph session (prevents double prompts)..."
        Disconnect-MgGraph -ErrorAction SilentlyContinue

        Write-Info "Connecting to Microsoft Graph tenant: $TenantId"
        Connect-MgGraph `
            -TenantId $TenantId `
            -Scopes $requiredScopes `
            -NoWelcome `
            -ContextScope Process `
            -ErrorAction Stop | Out-Null

        # Force token acquisition immediately so later Invoke-MgGraphRequest won't trigger another prompt.
        # /me is fine here since you later call it anyway.
        Write-Info "Validating Graph session (acquiring token)..."
        $null = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/me" -ErrorAction Stop

        Write-Ok "Connected to Microsoft Graph"
    }
    catch {
        $msg = $_ | Get-FriendlyErrorMessage
        throw "Failed to connect to Microsoft Graph. $msg"
    }
}

function New-AzureResourceGroup {
    <#
    .SYNOPSIS
        Ensures an Azure resource group exists; creates it if missing
    #>
    param(
        [string]$Name,
        [string]$Location
    )

    Write-Step "Ensuring resource group exists: $Name ($Location)"

    try {
        $rg = Get-AzResourceGroup -Name $Name -ErrorAction SilentlyContinue

        if ($rg) {
            Write-Ok "Resource group already exists: $($rg.ResourceGroupName)"
            return @{
                ResourceGroup = $rg
                AlreadyExisted = $true
            }
        }

        Write-Info "Resource group not found. Creating..."
        $rg = New-AzResourceGroup -Name $Name -Location $Location -Force -ErrorAction Stop

        Write-Ok "Resource group created: $($rg.ResourceGroupName)"
        return @{
            ResourceGroup = $rg
            AlreadyExisted = $false
        }
    }
    catch {
        $msg = $_ | Get-FriendlyErrorMessage
        throw "Failed to ensure resource group '$Name'. $msg"
    }
}

function Get-CurrentUserObjectId {
    <#
    .SYNOPSIS
        Gets the current user's object ID from Microsoft Graph
    #>

    Write-Step "Fetching current user (Graph /me)"

    try {
        $currentUser = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/me" -ErrorAction Stop
        Write-Ok "Current user: $($currentUser.displayName) ($($currentUser.userPrincipalName))"
        Write-Info "Object ID: $($currentUser.id)"
        return $currentUser.id
    }
    catch {
        $msg = $_ | Get-FriendlyErrorMessage
        throw "Failed to get current user ID from Graph. $msg"
    }
}

function Get-AgentBlueprintByDisplayName {
    <#
    .SYNOPSIS
        Finds an existing agent identity blueprint (application) by displayName
    #>
    param(
        [string]$DisplayName
    )

    $escaped = Escape-ODataString $DisplayName
    $uri = "https://graph.microsoft.com/beta/applications?`$filter=displayName eq '$escaped'&`$select=id,appId,displayName"

    try {
        $result = Invoke-MgGraphRequest -Method GET -Uri $uri -ErrorAction Stop
        return @($result.value)
    }
    catch {
        $msg = $_ | Get-FriendlyErrorMessage
        throw "Failed to query Graph applications for displayName '$DisplayName'. $msg"
    }
}

function New-AgentBlueprint {
    <#
    .SYNOPSIS
        Ensures an agentic blueprint exists; creates it if missing
    #>
    param(
        [string]$AgentName,
        [string]$SponsorUserId
    )

    $displayName = "$AgentName Agent Blueprint"
    Write-Step "Ensuring agentic blueprint exists: $displayName"

    try {
        $existing = Get-AgentBlueprintByDisplayName -DisplayName $displayName

        if ($existing.Count -gt 0) {
            if ($existing.Count -gt 1) {
                Write-Warn "Found $($existing.Count) applications with displayName '$displayName'. Using the first match: ObjectId=$($existing[0].id)"
            } else {
                Write-Ok "Blueprint already exists"
            }

            return @{
                AppId         = $existing[0].appId
                ObjectId      = $existing[0].id
                Blueprint     = $existing[0]
                AlreadyExisted = $true
            }
        }

        Write-Info "Blueprint not found. Creating..."
        $body = @{
            "@odata.type" = "Microsoft.Graph.AgentIdentityBlueprint"
            displayName = $displayName
            "sponsors@odata.bind" = @("https://graph.microsoft.com/v1.0/users/$SponsorUserId")
        }

        $blueprint = Invoke-MgGraphRequest -Method POST `
            -Uri "https://graph.microsoft.com/beta/applications/" `
            -Headers @{ "OData-Version" = "4.0" } `
            -Body ($body | ConvertTo-Json -Depth 10) `
            -ErrorAction Stop

        Write-Ok "Blueprint created"
        Write-Info "App ID:    $($blueprint.appId)"
        Write-Info "Object ID: $($blueprint.id)"

        return @{
            AppId          = $blueprint.appId
            ObjectId       = $blueprint.id
            Blueprint      = $blueprint
            AlreadyExisted = $false
        }
    }
    catch {
        $msg = $_ | Get-FriendlyErrorMessage
        throw "Failed to ensure agent blueprint '$displayName'. $msg"
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

    Write-Step "Saving provisioning state: $OutputPath"

    try {
        $State | ConvertTo-Json -Depth 20 | Out-File $OutputPath -Force -ErrorAction Stop
        Write-Ok "State saved"
    }
    catch {
        $msg = $_ | Get-FriendlyErrorMessage
        throw "Failed to save provisioning state to '$OutputPath'. $msg"
    }
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
    Write-Step "Reading configuration: $ConfigFilePath"
    $config = Read-ConfigFile -Path $ConfigFilePath
    Write-Ok "Configuration loaded"

    if (-not $config.tenant_id) { throw "Config is missing required value: tenant_id" }
    if (-not $config.agent_name) { throw "Config is missing required value: agent_name" }
    if (-not $config.region) { throw "Config is missing required value: region" }
    if (-not $config.perplexity_api_key) { throw "Config is missing required value: perplexity_api_key" }
    if (-not $config.perplexity_model) { throw "Config is missing required value: perplexity_model" }

    # 2. Authenticate
    Connect-AzureAndGraph -TenantId $config.tenant_id

    # 3. Get current user object ID
    $currentUserId = Get-CurrentUserObjectId

    # 4. Ensure resource group exists
    $resourceGroupName = "rg-$($config.agent_name)"
    $rgResult = New-AzureResourceGroup -Name $resourceGroupName -Location $config.region
    $resourceGroup = $rgResult.ResourceGroup

    # 5. Ensure agent blueprint exists
    $bpResult = New-AgentBlueprint -AgentName $config.agent_name -SponsorUserId $currentUserId

    # 6. Save state
    $state = @{
        Timestamp = Get-Date -Format "o"
        Config = $config

        ResourceGroup = @{
            Name          = $resourceGroup.ResourceGroupName
            Location      = $resourceGroup.Location
            Id            = $resourceGroup.ResourceId
            AlreadyExisted = [bool]$rgResult.AlreadyExisted
        }

        Blueprint = @{
            AppId          = $bpResult.AppId
            ObjectId       = $bpResult.ObjectId
            AlreadyExisted = [bool]$bpResult.AlreadyExisted
            DisplayName    = $bpResult.Blueprint.displayName
        }
    }

    Save-ProvisionState -State $state

    Write-Host ""
    Write-Host "=======================================" -ForegroundColor Green
    Write-Host "  Provisioning Complete!" -ForegroundColor Green
    Write-Host "=======================================" -ForegroundColor Green
    Write-Host ""

    Write-Info "Summary:"
    Write-Host "  Resource Group: $($state.ResourceGroup.Name) (AlreadyExisted=$($state.ResourceGroup.AlreadyExisted))" -ForegroundColor Gray
    Write-Host "  Blueprint:      $($state.Blueprint.DisplayName) (AlreadyExisted=$($state.Blueprint.AlreadyExisted))" -ForegroundColor Gray
    Write-Host ""

    Write-Host "Next steps:" -ForegroundColor Yellow
    Write-Host "  1. Review provision-state.json" -ForegroundColor Gray
    Write-Host ""

    return $state
}
catch {
    Write-Host ""
    Write-Host "=======================================" -ForegroundColor Red
    Write-Host "  Provisioning Failed" -ForegroundColor Red
    Write-Host "=======================================" -ForegroundColor Red

    $msg = $_ | Get-FriendlyErrorMessage
    Write-Fail $msg

    if ($_.ScriptStackTrace) {
        Write-Host "`n[TRACE] Script stack trace:" -ForegroundColor DarkGray
        Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
    }

    exit 1
}
