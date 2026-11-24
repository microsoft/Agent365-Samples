# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    Onboards one more tenant onto a shared (multi-tenant) Travel Agent AWS backend, in one command.

.DESCRIPTION
    For onboarding many tenants from one machine. Each tenant gets its own working folder outside
    this repository (a365 writes that tenant's .env and a365*.json there), so tenants never
    overwrite each other and no tenant files can be committed by accident. For tenant <Name>:

      1. Copies this sample into <TenantsRoot>\<Name> (no .env, a365 config, manifest, build output
         or node_modules from this folder).
      2. Finds the backend's messaging endpoint and checks that it serves -SecretPrefix.
      3. Signs Azure CLI in to -Tenant (az login), which a365 uses to pick the tenant.
      4. Runs register-tenant.ps1 in that folder: a365 setup all (agent <AgentName>), the Secrets
         Manager registration, and the blueprint's messaging endpoint. The client secret is then
         removed from the folder's .env (it is kept only in Secrets Manager) unless -KeepLocalSecret.
      5. Runs a365 publish, which builds manifest\manifest.zip with this tenant's blueprint and name.
      6. Appends the tenant to <TenantsRoot>\tenants.csv and prints the remaining admin steps.

    The backend loads new registrations at its next cold start. After onboarding a batch of tenants,
    restart it once with your usual deploy command (same -LlmProvider) plus -SettingsOnly (see the README).

.PREREQUISITES
    - PowerShell 7, Agent 365 CLI (a365), Azure CLI, AWS CLI v2 signed in to the backend's account
    - A deployed multi-tenant backend (deploy-aws.ps1 -TenantSecretPrefix <SecretPrefix>)
    - An account in the new tenant that can run a365 setup (Global Administrator, or the roles
      listed by 'a365 setup all --help')

.EXAMPLE
    ./add-tenant.ps1 -Name contoso -Tenant contoso.onmicrosoft.com -Region us-east-2
    ./add-tenant.ps1 -Name fabrikam -Tenant fabrikam.onmicrosoft.com -Region us-east-2 -PrepareOnly
#>

[CmdletBinding()]
param(
    # Short label for the tenant: the folder name and the default agent name (Travel-<Name>).
    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9-]{0,19}$')]
    [string]$Name,
    # Tenant domain or id to sign Azure CLI in to. Omit to use the tenant az is already signed in to.
    [string]$Tenant,
    [string]$Region,
    [ValidateLength(1, 40)]
    [string]$AgentName,
    [string]$MessagingEndpoint,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,62}[A-Za-z0-9]$')]
    [string]$FunctionName = 'travelagentdw',
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,62}[A-Za-z0-9]$')]
    [string]$EndpointName = 'prod',
    [string]$TenantsRoot = (Join-Path $HOME 'travel-agent-tenants'),
    [ValidatePattern('^[A-Za-z0-9/_+=.@-]+/$')]
    [string]$SecretPrefix = 'travelagent/tenants/',
    [string]$AwsProfile,
    [switch]$KeepLocalSecret,
    # Checks everything and shows what would happen, without signing in or changing anything.
    [switch]$PrepareOnly
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$Guid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

function Resolve-AwsCli {
    $cmd = Get-Command aws -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    foreach ($candidate in @("$env:ProgramFiles\Amazon\AWSCLIV2\aws.exe", "$env:LOCALAPPDATA\Programs\Amazon\AWSCLIV2\aws.exe")) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    throw "AWS CLI v2 not found. Install it (Windows: winget install Amazon.AWSCLI, others: https://aws.amazon.com/cli/) and re-run."
}

function Invoke-AwsJson([string[]]$Arguments) {
    $allArgs = $Arguments + @('--region', $Region, '--no-cli-pager', '--output', 'json')
    if ($AwsProfile) { $allArgs += @('--profile', $AwsProfile) }
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $all = & $script:AwsCli @allArgs 2>&1; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $previous }
    $out = (@($all | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n")
    $err = (@($all | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { $_.Exception.Message }) -join "`n").Trim()
    if ($code -ne 0) { throw "aws $($Arguments[0..1] -join ' ') failed: $err" }
    return ($out | ConvertFrom-Json)
}

function Read-DotEnvValue([string]$Path, [string]$Pattern) {
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match "^\s*(export\s+)?($Pattern)\s*=\s*(.*)$") { return @{ Key = $Matches[2]; Value = $Matches[3].Trim().Trim('"', "'") } }
    }
    return $null
}

# Files of this sample a tenant folder must not inherit: other tenants' settings and credentials,
# generated packages, and build output.
function Test-Excluded([IO.FileSystemInfo]$Item) {
    $n = $Item.Name
    if ($Item.PSIsContainer) { return $n -in @('node_modules', 'dist', 'manifest', 'logs', '.git') -or $n -like 'logs_extracted*' -or $n -like 'azlogs*' }
    if ($n -eq '.env.example') { return $false }
    return $n -eq '.env' -or $n -like '.env.*' -or $n -like 'a365*.json*' -or $n -like '*.zip' -or $n -like '*.log' -or $n -eq '.a365-workspace-detection.local.json'
}

$failed = $false
try {
    if ($PSVersionTable.PSVersion.Major -lt 7) { throw "Run this script in PowerShell 7 (pwsh); the Agent 365 CLI needs it." }
    foreach ($tool in 'a365', 'az') {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "'$tool' not found. See the README prerequisites." }
    }
    $AwsCli = Resolve-AwsCli
    if (-not $Region) { $Region = @($env:AWS_REGION, $env:AWS_DEFAULT_REGION) | Where-Object { $_ } | Select-Object -First 1 }
    if (-not $Region) { throw "Pass the backend's AWS Region with -Region, e.g. -Region us-east-2." }
    if (-not $AgentName) { $AgentName = "Travel-$Name" }
    if ("$AgentName Blueprint".Length -gt 30) { throw "'$AgentName Blueprint' is longer than the 30-character Teams app name limit; pass a shorter -AgentName." }

    # Tenant folders hold that tenant's settings, so they live outside any git working tree.
    $TenantsRoot = [IO.Path]::GetFullPath($TenantsRoot)
    $repoRoot = (& git -C $PSScriptRoot rev-parse --show-toplevel 2>$null)
    if ($LASTEXITCODE -eq 0 -and $repoRoot) {
        $repoFull = [IO.Path]::GetFullPath($repoRoot).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
        if (($TenantsRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar).StartsWith($repoFull, [StringComparison]::OrdinalIgnoreCase)) {
            throw "-TenantsRoot $TenantsRoot is inside the git repository $repoRoot. Use a folder outside it (default: $(Join-Path $HOME 'travel-agent-tenants'))."
        }
    }
    $folder = Join-Path $TenantsRoot $Name
    if (Test-Path -LiteralPath $folder) {
        throw ("$folder already exists. If an earlier run for '$Name' stopped part-way, finish it in that folder:`n" +
            "      cd '$folder'`n" +
            "      .\register-tenant.ps1 -SkipSetup -Region $Region -SecretPrefix $SecretPrefix -MessagingEndpoint <endpoint>   # if registration didn't finish`n" +
            "      a365 publish --aiteammate`n" +
            "    To start this tenant over instead, delete the folder (and the agent it created, if any).")
    }

    # --- Backend: endpoint and multi-tenant prefix -------------------------------------------------
    Write-Step "Checking the backend '$FunctionName' ($Region)"
    $account = (Invoke-AwsJson @('sts', 'get-caller-identity')).Account
    $endpoint = Invoke-AwsJson @('lambda-web', 'get-web-function-endpoint', '--function-name', $FunctionName, '--endpoint-name', $EndpointName)
    if (-not $MessagingEndpoint) {
        if (-not $endpoint.domainName) { throw "Endpoint '$EndpointName' of '$FunctionName' has no domain yet; deploy the backend first." }
        $MessagingEndpoint = "https://$($endpoint.domainName)/api/messages"
    }
    if ($MessagingEndpoint -notmatch '^https://[^/\s]+/api/messages$') { throw "-MessagingEndpoint must look like https://<backend-url>/api/messages." }
    $revisionId = @($endpoint.revisionWeights | Sort-Object weight -Descending)[0].revisionId
    $revision = Invoke-AwsJson @('lambda-web', 'get-web-function-revision', '--function-name', $FunctionName, '--revision-id', $revisionId)
    $livePrefix = $revision.serviceConfig.environmentVariables.A365_TENANT_SECRETS_PREFIX
    if ($livePrefix -ne $SecretPrefix) {
        throw ("The backend isn't serving '$SecretPrefix' (its tenant prefix is '$livePrefix'). Deploy it in multi-tenant mode first: " +
            ".\deploy-aws.ps1 -Region $Region -TenantSecretPrefix $SecretPrefix ...")
    }
    Write-Host "    AWS account $account, endpoint $MessagingEndpoint, prefix $SecretPrefix"

    if ($PrepareOnly) {
        Write-Host ""
        Write-Host "==> Ready (nothing changed). Without -PrepareOnly this would:" -ForegroundColor Green
        Write-Host "    1. Copy the sample to $folder"
        Write-Host "    2. Sign Azure CLI in to $(if ($Tenant) { $Tenant } else { 'the tenant az is signed in to now' })"
        Write-Host "    3. Create agent '$AgentName' there (a365 setup all) and register it under $SecretPrefix"
        Write-Host "    4. Point its blueprint at $MessagingEndpoint and build $folder\manifest\manifest.zip"
        return
    }

    # --- Tenant sign-in --------------------------------------------------------------------------
    if ($Tenant) {
        Write-Step "Signing Azure CLI in to $Tenant (a browser window opens)"
        & az login --tenant $Tenant --allow-no-subscriptions --only-show-errors --output none
        if ($LASTEXITCODE -ne 0) { throw "az login --tenant $Tenant failed." }
    }
    $azTenant = (& az account show --query tenantId -o tsv 2>$null)
    if (-not $azTenant) { throw "Azure CLI isn't signed in. Pass -Tenant <domain or id>, or run 'az login --tenant <tenant>' first." }
    if ($Tenant -match $Guid -and $azTenant -ne $Tenant) { throw "Azure CLI is signed in to $azTenant, not $Tenant." }
    $azUser = (& az account show --query user.name -o tsv 2>$null)
    if (-not $Tenant) {
        $answer = Read-Host "Create agent '$AgentName' in tenant $azTenant (signed in as $azUser)? [y/N]"
        if ($answer -notmatch '^(y|yes)$') { throw "Stopped; nothing was changed. Pass -Tenant to sign in to the right tenant." }
    }
    Write-Host "    Tenant $azTenant, signed in as $azUser"

    # --- Tenant folder ---------------------------------------------------------------------------
    Write-Step "Creating the tenant folder $folder"
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $PSScriptRoot -Force) {
        if (-not (Test-Excluded $item)) { Copy-Item -LiteralPath $item.FullName -Destination $folder -Recurse -Force }
    }

    # --- Agent, registration and endpoint (register-tenant.ps1 in the tenant folder) --------------
    $registerArgs = @{ AgentName = $AgentName; MessagingEndpoint = $MessagingEndpoint; Region = $Region; SecretPrefix = $SecretPrefix }
    if ($AwsProfile) { $registerArgs.AwsProfile = $AwsProfile }
    if (-not $KeepLocalSecret) { $registerArgs.RemoveLocalSecret = $true }
    $global:LASTEXITCODE = 0
    & (Join-Path $folder 'register-tenant.ps1') @registerArgs
    if ($LASTEXITCODE -ne 0) { throw "register-tenant.ps1 stopped (see above). Fix it, then finish in $folder as described in the README." }

    # --- Package ----------------------------------------------------------------------------------
    Write-Step "Building the agent package (a365 publish)"
    Push-Location -LiteralPath $folder
    try {
        & a365 publish --aiteammate
        if ($LASTEXITCODE -ne 0) { throw "a365 publish failed (exit $LASTEXITCODE). Re-run it in $folder." }
    } finally { Pop-Location }
    $package = Join-Path $folder 'manifest\manifest.zip'
    $manifest = Get-Content -LiteralPath (Join-Path $folder 'manifest\manifest.json') -Raw | ConvertFrom-Json

    # --- Ledger -------------------------------------------------------------------------------------
    $clientId = Read-DotEnvValue (Join-Path $folder '.env') 'connections__[^=]+__settings__clientId'
    $ledger = Join-Path $TenantsRoot 'tenants.csv'
    [pscustomobject]@{
        Name = $Name; TenantId = $azTenant; BlueprintId = $clientId.Value; AgentName = $AgentName
        AppName = $manifest.name.short; Folder = $folder; Package = $package; RegisteredAt = (Get-Date).ToString('s')
    } | Export-Csv -LiteralPath $ledger -Append -NoTypeInformation

    Write-Host ""
    Write-Host "==> Tenant '$Name' onboarded ($AgentName, blueprint $($clientId.Value))." -ForegroundColor Green
    Write-Host "    Package: $package"
    Write-Host "    Remaining steps, signed in to tenant $azTenant as an admin:"
    Write-Host "      1. https://admin.microsoft.com > Agents > All agents > Upload custom agent: upload the package, then approve it."
    Write-Host "      2. License the agent's user, and create its OneDrive: Request-SPOPersonalSite -UserEmails <agent user UPN>"
    Write-Host "      3. In Teams, hire the agent and send it a message."
    Write-Host "    After the batch, restart the backend once: your deploy command (same -LlmProvider) plus -SettingsOnly."
    Write-Host "    All onboarded tenants: $ledger"
} catch {
    Write-Host ""
    Write-Host "Onboarding stopped: $($_.Exception.Message)" -ForegroundColor Red
    $failed = $true
}

if ($failed) { exit 1 }
