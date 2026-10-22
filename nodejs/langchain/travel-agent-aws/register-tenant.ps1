# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    Registers one tenant's Travel Agent AWS blueprint with a shared (multi-tenant) AWS backend.

.DESCRIPTION
    Run once per agent blueprint, in the tenant that owns it. No secrets are copied by hand:

      1. Unless -SkipSetup, runs `a365 setup all --agent-name <AgentName> --aiteammate --m365` for the
         tenant you're signed in to with Azure CLI (az login --tenant <tenant>); it writes .env.
      2. Reads the blueprint id, tenant id, and client secret from .env.
      3. Stores them in the AWS Secrets Manager secret <SecretPrefix><tenantId>/<blueprintId>
         (created or updated from an owner-only temp file; values never go on a command line).
      4. With -MessagingEndpoint, points the blueprint at the shared backend
         (`a365 setup blueprint --update-endpoint <endpoint> --m365`).
      5. With -RemoveLocalSecret, blanks the client secret in .env afterwards.

    The backend (deploy-aws.ps1 -TenantSecretPrefix <SecretPrefix>) loads every registration at
    cold start. To serve a new registration immediately, the backend owner runs
    `.\deploy-aws.ps1 -TenantSecretPrefix <SecretPrefix> -SettingsOnly` (it publishes a new revision).

.PREREQUISITES
    - Agent 365 CLI (a365), Azure CLI signed in to the agent's tenant, PowerShell 7 for a365
    - AWS CLI v2 signed in to the backend's AWS account, allowed to create and update secrets under
      the tenant's prefix (secretsmanager:CreateSecret, PutSecretValue, DescribeSecret, RestoreSecret,
      TagResource on arn:aws:secretsmanager:<region>:<account>:secret:<SecretPrefix><tenantId>/*)

.EXAMPLE
    az login --tenant contoso.onmicrosoft.com
    ./register-tenant.ps1 -AgentName Travel-contoso -Region us-east-2 `
        -MessagingEndpoint https://<backend-url>/api/messages
    ./register-tenant.ps1 -SkipSetup -Region us-east-2     # register the agent already in .env
#>

[CmdletBinding()]
param(
    [string]$AgentName,
    [string]$MessagingEndpoint,
    [string]$Region,
    [string]$AwsProfile,
    [ValidatePattern('^[A-Za-z0-9/_+=.@-]+/$')]
    [string]$SecretPrefix = 'travelagent/tenants/',
    [string]$EnvFile = '.env',
    [switch]$SkipSetup,
    [switch]$RemoveLocalSecret
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$Guid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

# The helpers below match deploy-aws.ps1; keep them in sync.
function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

function Resolve-AwsCli {
    $cmd = Get-Command aws -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    foreach ($candidate in @("$env:ProgramFiles\Amazon\AWSCLIV2\aws.exe", "$env:LOCALAPPDATA\Programs\Amazon\AWSCLIV2\aws.exe")) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    throw "AWS CLI v2 not found. Install it (Windows: winget install Amazon.AWSCLI, others: https://aws.amazon.com/cli/) and re-run."
}

function Invoke-Aws {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $allArgs = $Arguments + $script:AwsCommonArgs
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $all = & $script:AwsCli @allArgs 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    $stdout = @($all | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] })
    $stderr = (@($all | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } |
        ForEach-Object { $_.Exception.Message }) -join "`n")
    return [pscustomobject]@{ ExitCode = $exitCode; Output = ($stdout -join "`n"); Error = $stderr.Trim() }
}

function New-PrivateFile([string]$Path) {
    [IO.File]::WriteAllText($Path, '')
    if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
        $acl = New-Object System.Security.AccessControl.FileSecurity
        $acl.SetAccessRuleProtection($true, $false)
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
            [Security.Principal.WindowsIdentity]::GetCurrent().User, 'FullControl', 'Allow')))
        Set-Acl -LiteralPath $Path -AclObject $acl
    } else {
        & chmod 600 $Path
        if ($LASTEXITCODE -ne 0) { throw "Could not restrict access to $Path." }
    }
}

function Read-DotEnv([string]$Path) {
    $settings = [ordered]@{}
    foreach ($raw in Get-Content -LiteralPath $Path) {
        $line = $raw.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        if ($line.StartsWith('export ')) { $line = $line.Substring(7).TrimStart() }
        $eq = $line.IndexOf('=')
        if ($eq -lt 1) { continue }
        $key = $line.Substring(0, $eq).Trim()
        $value = $line.Substring($eq + 1).Trim()
        if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        } else {
            $comment = $value.IndexOf(' #')
            if ($comment -ge 0) { $value = $value.Substring(0, $comment).TrimEnd() }
        }
        $settings[$key] = $value
    }
    return $settings
}

Push-Location -Path $PSScriptRoot
$failed = $false
$secretFile = $null
try {
    $AwsCli = Resolve-AwsCli
    if (-not $Region) { $Region = @($env:AWS_REGION, $env:AWS_DEFAULT_REGION) | Where-Object { $_ } | Select-Object -First 1 }
    if (-not $Region) { throw "Pass the backend's AWS Region with -Region, e.g. -Region us-east-2." }
    $AwsCommonArgs = @('--region', $Region, '--no-cli-pager')
    if ($AwsProfile) { $AwsCommonArgs += @('--profile', $AwsProfile) }

    # --- 1. Agent 365 setup in the signed-in tenant ------------------------------------------
    if (-not $SkipSetup) {
        if (-not $AgentName) { throw "Pass -AgentName (e.g. -AgentName Travel-contoso), or -SkipSetup to register the agent already in $EnvFile." }
        if (-not (Get-Command a365 -ErrorAction SilentlyContinue)) { throw "Agent 365 CLI (a365) not found. Install it: dotnet tool install --global Microsoft.Agents.A365.DevTools.Cli --prerelease" }
        $azTenant = (& az account show --query tenantId -o tsv 2>$null)
        if (-not $azTenant) { throw "Azure CLI isn't signed in. Run 'az login --tenant <the agent's tenant>' first." }
        Write-Step "Creating agent '$AgentName' in tenant $azTenant (a365 setup all)"
        & a365 setup all --agent-name $AgentName --aiteammate --m365
        if ($LASTEXITCODE -ne 0) { throw "'a365 setup all' failed (exit $LASTEXITCODE). Fix the reported issue and re-run, or re-run with -SkipSetup once setup has completed." }
    }

    # --- 2. Blueprint credentials from .env ---------------------------------------------------
    Write-Step "Reading the blueprint from $EnvFile"
    if (-not (Test-Path -LiteralPath $EnvFile)) { throw "$EnvFile not found. Run without -SkipSetup, or run 'a365 setup all --aiteammate --m365' first." }
    $dotEnv = Read-DotEnv $EnvFile
    $clientIdKey = @($dotEnv.Keys | Where-Object { $_ -match '^connections__(.+)__settings__clientId$' }) | Select-Object -First 1
    if (-not $clientIdKey) { throw "$EnvFile has no connections__<name>__settings__clientId." }
    $connection = ($clientIdKey -replace '^connections__(.+)__settings__clientId$', '$1')
    $blueprintId = "$($dotEnv[$clientIdKey])".Trim().ToLowerInvariant()
    $tenantId = "$($dotEnv["connections__${connection}__settings__tenantId"])".Trim().ToLowerInvariant()
    $clientSecret = $dotEnv["connections__${connection}__settings__clientSecret"]
    if ($blueprintId -notmatch $Guid) { throw "The blueprint id in $EnvFile isn't a GUID." }
    if ($tenantId -notmatch $Guid) { throw "connections__${connection}__settings__tenantId in $EnvFile isn't a GUID." }
    if (-not $clientSecret) { throw "connections__${connection}__settings__clientSecret in $EnvFile is empty (was it removed by an earlier -RemoveLocalSecret?). Create a new secret with 'a365 setup blueprint' and re-run." }
    Write-Host "    Tenant $tenantId, blueprint $blueprintId"

    # --- 3. Secrets Manager registration -------------------------------------------------------
    $identity = Invoke-Aws @('sts', 'get-caller-identity', '--query', 'Account', '--output', 'text')
    if ($identity.ExitCode -ne 0) { throw "Not signed in to AWS. Run 'aws login' (or 'aws configure sso'), then re-run.`n$($identity.Error)" }
    $secretName = "$SecretPrefix$tenantId/$blueprintId"
    Write-Step "Registering $secretName in AWS account $($identity.Output.Trim()) ($Region)"
    $secretFile = Join-Path ([IO.Path]::GetTempPath()) "tenant-$([guid]::NewGuid().ToString('N')).json"
    New-PrivateFile $secretFile
    [IO.File]::WriteAllText($secretFile, (@{ tenantId = $tenantId; blueprintId = $blueprintId; clientSecret = $clientSecret } | ConvertTo-Json -Compress))

    $describe = Invoke-Aws @('secretsmanager', 'describe-secret', '--secret-id', $secretName, '--output', 'json')
    if ($describe.ExitCode -eq 0) {
        if (($describe.Output | ConvertFrom-Json).DeletedDate) {
            $restore = Invoke-Aws @('secretsmanager', 'restore-secret', '--secret-id', $secretName, '--output', 'json')
            if ($restore.ExitCode -ne 0) { throw "Could not restore $secretName (scheduled for deletion):`n$($restore.Error)" }
        }
        $put = Invoke-Aws @('secretsmanager', 'put-secret-value', '--secret-id', $secretName, '--secret-string', "file://$secretFile", '--output', 'json')
        if ($put.ExitCode -ne 0) { throw "Could not update ${secretName}:`n$($put.Error)" }
        Write-Host "    Updated the existing registration."
    } elseif ($describe.Error -match 'ResourceNotFoundException') {
        $create = Invoke-Aws @('secretsmanager', 'create-secret', '--name', $secretName,
            '--description', "Travel Agent AWS blueprint registration (tenant $tenantId)",
            '--secret-string', "file://$secretFile",
            '--tags', "Key=a365:tenantId,Value=$tenantId", "Key=a365:blueprintId,Value=$blueprintId", '--output', 'json')
        if ($create.ExitCode -ne 0) { throw "Could not create ${secretName}:`n$($create.Error)" }
        Write-Host "    Created." -ForegroundColor Green
    } else {
        throw "Could not check ${secretName}:`n$($describe.Error)"
    }

    # --- 4. Point the blueprint at the shared backend --------------------------------------------
    if ($MessagingEndpoint) {
        if ($MessagingEndpoint -notmatch '^https://[^/\s]+/api/messages$') { throw "-MessagingEndpoint must look like https://<backend-url>/api/messages." }
        Write-Step "Pointing the blueprint at $MessagingEndpoint"
        if (-not (Test-Path -LiteralPath 'a365.config.json')) { throw "a365.config.json not found in $PSScriptRoot; run a365 setup in this folder first." }
        & a365 setup blueprint --update-endpoint $MessagingEndpoint --m365
        if ($LASTEXITCODE -ne 0) { throw "'a365 setup blueprint --update-endpoint' failed (exit $LASTEXITCODE); the registration itself succeeded. Re-run it after fixing the reported issue." }
    }

    # --- 5. Optional: drop the local copy of the secret ------------------------------------------
    if ($RemoveLocalSecret) {
        $pattern = "^\s*(export\s+)?connections__$([regex]::Escape($connection))__settings__clientSecret\s*="
        $lines = Get-Content -LiteralPath $EnvFile | ForEach-Object { if ($_ -match $pattern) { "connections__${connection}__settings__clientSecret=" } else { $_ } }
        [IO.File]::WriteAllLines((Resolve-Path -LiteralPath $EnvFile), [string[]]$lines, (New-Object Text.UTF8Encoding($false)))
        Write-Host "    Removed the client secret from $EnvFile (it is now only in Secrets Manager)."
    }

    Write-Host ""
    Write-Host "==> Registered." -ForegroundColor Green
    Write-Host "    The backend serves this blueprint after its next cold start. To serve it now, the backend owner runs:"
    Write-Host "      .\deploy-aws.ps1 -Region $Region -TenantSecretPrefix $SecretPrefix -SettingsOnly"
} catch {
    Write-Host ""
    Write-Host "Registration stopped: $($_.Exception.Message)" -ForegroundColor Red
    $failed = $true
} finally {
    if ($secretFile) { Remove-Item -LiteralPath $secretFile -Force -ErrorAction SilentlyContinue }
    Pop-Location
}

if ($failed) { exit 1 }
