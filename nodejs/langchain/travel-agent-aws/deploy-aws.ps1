# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    One-click deploy of the Travel Agent AWS messaging endpoint to AWS
    (AWS Lambda Web Functions + Amazon Bedrock).

.DESCRIPTION
    Runs the agent as an AWS Lambda Web Function (a managed Node.js HTTP server with a
    built-in HTTPS endpoint) and points the LLM at Amazon Bedrock through the function's
    IAM execution role, so no model keys are stored anywhere. Safe to re-run: the first run
    creates everything, later runs publish a new revision behind the same URL.

      1. Checks the AWS CLI (v2 with `lambda-web`), your AWS sign-in, and Bedrock access to -ModelId.
      2. Creates the IAM execution role if needed (CloudWatch Logs) and grants it Bedrock access to
         -ModelId only (inline policy bedrock-invoke).
      3. Stores the secret settings from -EnvFile (client secrets, keys, tokens, passwords) in the
         AWS Secrets Manager secret <FunctionName>/agent365, from an owner-only temp file, and lets
         the role read that one secret (inline policy secrets-read).
      4. Builds a production-only package (npm install --omit=dev, which runs tsc) in a temp folder.
      5. Runs `aws lambda-web deploy`, passing the non-secret settings in -EnvFile plus
         A365_SECRETS_ARN as environment variables. Secret values are never passed on the AWS CLI
         command line or stored in the function's environment; the app loads them at cold start.
      6. Waits for /api/health and confirms /api/messages rejects unauthenticated calls.
      7. With -UpdateA365Endpoint, points the Agent 365 blueprint at the new URL
         (`a365 setup blueprint --update-endpoint <url>/api/messages --m365`).

    With -SettingsOnly, step 4 is skipped and the role isn't created: the settings in -EnvFile are
    published as a new revision that reuses the deployed code and role, for example after
    `a365 setup` writes new blueprint credentials to .env. The Bedrock grant, the secret value,
    and the secrets-read grant are still refreshed. The first deploy after upgrading from a version
    without Secrets Manager support must be a full deploy; -SettingsOnly refuses to move secrets out
    of the environment of code that can't read them.

.PREREQUISITES
    - AWS CLI v2 with `aws lambda-web` (2.38+), signed in: `aws login`, `aws configure sso`, or `aws configure`
    - Node.js 24+ and npm
    - A .env with the agent's Agent 365 settings (written by `a365 setup all --aiteammate --m365`)
    - Amazon Bedrock access to -ModelId in -Region. The default, Amazon Nova 2 Lite, needs no extra
      sign-up; Anthropic Claude models need the one-time Anthropic use-case form first. New AWS
      accounts can start with Bedrock quotas of 0; use -LlmProvider AzureOpenAI until they're raised.
    - For -LlmProvider AzureOpenAI: AZURE_OPENAI_ENDPOINT (https://<resource>.openai.azure.com/),
      AZURE_OPENAI_DEPLOYMENT and AZURE_OPENAI_API_KEY in -EnvFile, from an Azure AI Foundry or
      Azure OpenAI resource. The key is stored in Secrets Manager and no Bedrock access is granted.
    - For -TenantSecretPrefix (one backend for many tenants' blueprints): blueprints registered with
      register-tenant.ps1 under that prefix. The role gets the inline policy tenant-secrets-read, and
      the app loads the registrations at cold start; -EnvFile then needs no connection settings.
    - For -UpdateA365Endpoint: the Agent 365 CLI (`a365`), a365.config.json in this folder, and
      owner rights on the agent blueprint

.EXAMPLE
    ./deploy-aws.ps1
    ./deploy-aws.ps1 -UpdateA365Endpoint
    ./deploy-aws.ps1 -SettingsOnly
    ./deploy-aws.ps1 -Region us-west-2 -ModelId us.anthropic.claude-sonnet-4-6 -AwsProfile my-sso
    ./deploy-aws.ps1 -LlmProvider AzureOpenAI -UpdateA365Endpoint
    ./deploy-aws.ps1 -TenantSecretPrefix travelagent/tenants/   # multi-tenant: see register-tenant.ps1
#>

[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,62}[A-Za-z0-9]$')]
    [string]$FunctionName = 'travelagentdw',
    [string]$Region,
    [string]$ModelId,
    [ValidateSet('Bedrock', 'AzureOpenAI')]
    [string]$LlmProvider = 'Bedrock',
    # Multi-tenant mode: serve every blueprint registered with register-tenant.ps1 under this
    # Secrets Manager name prefix (one secret per blueprint: <prefix><tenantId>/<blueprintId>).
    [ValidatePattern('^[A-Za-z0-9/_+=.@-]+/$')]
    [string]$TenantSecretPrefix,
    # Turns a multi-tenant backend back into a single-tenant one (removes the prefix and its grant).
    [switch]$DisableMultiTenant,
    [string]$AwsProfile,
    [string]$EnvFile = '.env',
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,62}[A-Za-z0-9]$')]
    [string]$EndpointName = 'prod',
    [ValidateRange(30, 900)]
    [int]$TimeoutSeconds = 300,
    [switch]$SettingsOnly,
    [switch]$UpdateA365Endpoint,
    [switch]$SkipModelCheck,
    [switch]$TailLogs
)

$ErrorActionPreference = 'Stop'
# Native tools (aws, npm, a365) report failure through exit codes, which this script checks itself.
$PSNativeCommandUseErrorActionPreference = $false
# Windows PowerShell 5.1 doesn't offer TLS 1.2 by default; AWS endpoints require it.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# .env keys that must not be shipped: AWS-reserved names and credentials, the LLM settings of
# the provider not in use, local-dev-only switches, and the values this script sets itself.
# With -LlmProvider AzureOpenAI the AZURE_OPENAI_* settings ship (the API key through Secrets Manager).
$ExcludedLlmPrefixes = if ($LlmProvider -eq 'AzureOpenAI') { 'OPENAI_' } else { 'AZURE_OPENAI_|OPENAI_' }
$ExcludedSettingsPattern = "^(AWS_|LAMBDA_|_|$ExcludedLlmPrefixes|WEBSITE_|SCM_)|^(PORT|NODE_ENV|BEARER_TOKEN|ENABLE_TEST_ENDPOINT|LLM_PROVIDER|BEDROCK_MODEL_ID|BEDROCK_REGION)$"
# Settings whose values go to AWS Secrets Manager instead of the function environment (-match is
# case-insensitive). A365_SECRETS_ARN is the reference to that secret, not a secret itself, and
# token-count settings such as BEDROCK_MAX_TOKENS are tuning values.
$SecretSettingsPattern = '(secret|password|_key$|token)|^connections__.+__settings__clientSecret$'
$NonSecretSettingsPattern = '^A365_SECRETS_ARN$|^A365_TENANT_SECRETS_PREFIX$|(_url|endpoint|_tokens)$'

function Test-SecretSettingName([string]$Name) {
    return ($Name -match $SecretSettingsPattern) -and ($Name -notmatch $NonSecretSettingsPattern)
}

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

function Resolve-AwsCli {
    $cmd = Get-Command aws -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    # winget/MSI installs aren't on PATH until a new terminal is opened.
    foreach ($candidate in @("$env:ProgramFiles\Amazon\AWSCLIV2\aws.exe", "$env:LOCALAPPDATA\Programs\Amazon\AWSCLIV2\aws.exe")) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    throw "AWS CLI v2 not found. Install it (Windows: winget install Amazon.AWSCLI, others: https://aws.amazon.com/cli/) and re-run."
}

# Runs the AWS CLI with the common --region/--profile flags and captures its output. Returns exit
# code, stdout and stderr instead of throwing, so callers can turn AWS errors into actionable messages.
function Invoke-Aws {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $allArgs = $Arguments + $script:AwsCommonArgs
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # 2>&1 turns stderr lines into ErrorRecords; keep only their text. (Redirecting to a file in
        # Windows PowerShell 5.1 writes "aws.exe : ... NativeCommandError" decoration around the message.)
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

function Write-JsonFile([string]$Path, $Object) {
    # UTF-8 without BOM: the AWS CLI rejects file:// JSON that starts with a BOM.
    [IO.File]::WriteAllText($Path, ($Object | ConvertTo-Json -Depth 20 -Compress))
}

# Creates an empty file that only the current user can read, before any secret is written to it.
function New-PrivateFile([string]$Path) {
    [IO.File]::WriteAllText($Path, '')
    if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
        $acl = New-Object System.Security.AccessControl.FileSecurity
        $acl.SetAccessRuleProtection($true, $false)
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
            [Security.Principal.WindowsIdentity]::GetCurrent().User, 'FullControl', 'Allow')))
        Set-Acl -LiteralPath $Path -AclObject $acl
    } else {
        # No '--': BSD/macOS chmod stops parsing options at '600' and would treat '--' as a file.
        # The path is an absolute temp path, so it never starts with '-'.
        & chmod 600 $Path
        if ($LASTEXITCODE -ne 0) { throw "Could not restrict access to $Path." }
    }
}

# Setting names (never values) and execution role of the revisions the endpoint serves, or $null
# when the function or endpoint doesn't exist yet.
function Get-LiveRevisionInfo {
    $endpointInfo = Invoke-Aws @('lambda-web', 'get-web-function-endpoint', '--function-name', $FunctionName,
        '--endpoint-name', $EndpointName, '--query', 'revisionWeights[].revisionId', '--output', 'json')
    if ($endpointInfo.ExitCode -ne 0) { return $null }
    $revisionIds = @($endpointInfo.Output | ConvertFrom-Json) | Where-Object { $_ }
    if (-not $revisionIds) { return $null }
    $names = @()
    $roleArn = $null
    foreach ($revisionId in $revisionIds) {
        $revision = Invoke-Aws @('lambda-web', 'get-web-function-revision', '--function-name', $FunctionName, '--revision-id', $revisionId,
            '--query', '{names: keys(serviceConfig.environmentVariables || `{}`), role: serviceConfig.executionRoleArn}', '--output', 'json')
        if ($revision.ExitCode -ne 0) { throw "Could not read revision $revisionId of '$FunctionName':`n$($revision.Error)" }
        $info = $revision.Output | ConvertFrom-Json
        $names += @($info.names)
        if (-not $roleArn) { $roleArn = $info.role }
    }
    return [pscustomobject]@{ SettingNames = @($names | Where-Object { $_ } | Sort-Object -Unique); RoleArn = $roleArn }
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

function Get-HttpStatus([scriptblock]$Request) {
    try {
        return [int](& $Request).StatusCode
    } catch {
        $response = $_.Exception.Response
        if ($response) { return [int]$response.StatusCode }
        return 0
    }
}

Push-Location -Path $PSScriptRoot
$workDir = $null
try {
    $AwsCli = Resolve-AwsCli
    # Same precedence as the AWS CLI: AWS_REGION, AWS_DEFAULT_REGION, then the profile's region.
    if (-not $Region) { $Region = @($env:AWS_REGION, $env:AWS_DEFAULT_REGION) | Where-Object { $_ } | Select-Object -First 1 }
    if (-not $Region) {
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $profileArgs = @()
        if ($AwsProfile) { $profileArgs = @('--profile', $AwsProfile) }
        $Region = & $AwsCli configure get region @profileArgs 2>$null | Select-Object -First 1
        $ErrorActionPreference = $previous
    }
    if (-not $Region) { $Region = 'us-east-1' }
    $Region = "$Region".Trim()
    if ($Region -notmatch '^[a-z]{2}(-[a-z]+)+-\d+$') { throw "'$Region' isn't a valid AWS Region. Pass one with -Region, e.g. -Region us-east-1." }
    # Bedrock cross-Region inference profiles are geo-scoped (us.* only works from US Regions), so the
    # default model and the hints use the profile that matches the Region.
    $GeoPrefix = switch -Regex ($Region) { '^us-' { 'us'; break } '^eu-' { 'eu'; break } default { 'global' } }
    if (-not $ModelId) { $ModelId = "$GeoPrefix.amazon.nova-2-lite-v1:0" }

    $AwsCommonArgs = @('--region', $Region, '--no-cli-pager')
    if ($AwsProfile) { $AwsCommonArgs += @('--profile', $AwsProfile) }

    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npm -and -not $SettingsOnly) { throw "npm not found. Install Node.js 24+ (https://nodejs.org/) and re-run." }

    # --- 1. Preflight -----------------------------------------------------------------------
    Write-Step "Reading settings from $EnvFile"
    if (-not (Test-Path -LiteralPath $EnvFile)) {
        throw "$EnvFile not found. Run 'a365 setup all --aiteammate --m365' in this folder (it writes .env), or create it as described in README.md."
    }
    $settings = [ordered]@{}
    $secretSettings = [ordered]@{}
    $skipped = @()
    $dotEnv = Read-DotEnv $EnvFile
    foreach ($key in $dotEnv.Keys) {
        $value = $dotEnv[$key]
        if ($key -match $ExcludedSettingsPattern -or [string]::IsNullOrEmpty($value)) { $skipped += $key; continue }
        if ($key -notmatch '^[A-Za-z][A-Za-z0-9_]*$') { Write-Warning "Skipping '$key': AWS environment variable names allow only letters, digits, and underscores."; continue }
        # Secret values go to Secrets Manager through a file, never onto the command line.
        if (Test-SecretSettingName $key) { $secretSettings[$key] = $value; continue }
        if ($value.Contains('"')) { throw "The value of '$key' in $EnvFile contains a double quote, which can't be passed safely to the AWS CLI." }
        $settings[$key] = $value
    }
    if (-not $TenantSecretPrefix -and -not ($settings.Keys | Where-Object { $_ -match '^connections__.+__settings__clientId$' })) {
        throw "$EnvFile has no Agent 365 connection settings (connections__<name>__settings__clientId). Run 'a365 setup all --aiteammate --m365' first."
    }
    if ($TenantSecretPrefix) { $settings['A365_TENANT_SECRETS_PREFIX'] = $TenantSecretPrefix }
    $settings['NODE_ENV'] = 'production'
    if ($LlmProvider -eq 'AzureOpenAI') {
        $missing = @(@('AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT') | Where-Object { -not $settings.Contains($_) })
        if (-not $secretSettings.Contains('AZURE_OPENAI_API_KEY')) { $missing += 'AZURE_OPENAI_API_KEY' }
        if ($missing) {
            throw "-LlmProvider AzureOpenAI needs $($missing -join ', ') in $EnvFile (from your Azure AI Foundry / Azure OpenAI resource: Keys and Endpoint, and the model deployment name)."
        }
        # The app derives the resource name from this host, so it must be the Azure OpenAI endpoint.
        # Foundry often shows the v1 API URL (…/openai/v1); keep only the resource host.
        $settings['AZURE_OPENAI_ENDPOINT'] = $settings['AZURE_OPENAI_ENDPOINT'] -replace '^(https://[^/]+).*$', '$1/'
        if ($settings['AZURE_OPENAI_ENDPOINT'] -notmatch '^https://[A-Za-z0-9-]+\.(openai\.azure\.com|cognitiveservices\.azure\.com)/?$') {
            throw "AZURE_OPENAI_ENDPOINT must look like https://<resource>.openai.azure.com/ (in Foundry: your resource > Overview > Azure OpenAI endpoint)."
        }
        $settings['LLM_PROVIDER'] = 'azure-openai'
    } else {
        $settings['LLM_PROVIDER'] = 'bedrock'
        $settings['BEDROCK_MODEL_ID'] = $ModelId
        $settings['BEDROCK_REGION'] = $Region
    }
    # The packager only accepts the entry point together with --code; settings-only updates keep it.
    if (-not $SettingsOnly) { $settings['AWS_LAMBDA_NODEJS_ENTRYPOINT'] = 'dist/lambda.js' }
    Write-Host "    Passing $($settings.Count) settings; not shipping: $(if ($skipped) { $skipped -join ', ' } else { '(none)' })"
    $secretName = "$FunctionName/agent365"
    if ($secretSettings.Count -gt 0) {
        Write-Host "    Storing $($secretSettings.Count) secrets in Secrets Manager (${secretName}): $($secretSettings.Keys -join ', ')"
    }

    Write-Step "Checking AWS sign-in"
    $identityResult = Invoke-Aws @('sts', 'get-caller-identity', '--output', 'json')
    if ($identityResult.ExitCode -ne 0) {
        throw "Not signed in to AWS. Run 'aws login' (or 'aws configure sso' / 'aws configure'), then re-run.`n$($identityResult.Error)"
    }
    $identity = $identityResult.Output | ConvertFrom-Json
    $accountId = $identity.Account
    $partition = ($identity.Arn -split ':')[1]
    Write-Host "    Account: $accountId ($($identity.Arn))"
    Write-Host "    Region:  $Region"

    $webSettings = Invoke-Aws @('lambda-web', 'get-web-account-settings', '--output', 'json')
    if ($webSettings.ExitCode -ne 0) {
        if ($webSettings.Error -match 'Invalid choice') {
            throw "This AWS CLI ($AwsCli) has no 'lambda-web' command. Update to the latest AWS CLI v2 and re-run."
        }
        throw "AWS Lambda Web Functions isn't reachable in $Region with these credentials:`n$($webSettings.Error)"
    }

    $workDir = Join-Path ([IO.Path]::GetTempPath()) "$FunctionName-aws-deploy-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    New-Item -ItemType Directory -Path $workDir | Out-Null

    if (-not $SkipModelCheck -and $LlmProvider -eq 'AzureOpenAI') {
        $aoaiDeployment = $settings['AZURE_OPENAI_DEPLOYMENT']
        Write-Step "Checking Azure OpenAI deployment $aoaiDeployment"
        $apiVersion = if ($settings.Contains('AZURE_OPENAI_API_VERSION')) { $settings['AZURE_OPENAI_API_VERSION'] } else { '2024-12-01-preview' }
        $uri = "$($settings['AZURE_OPENAI_ENDPOINT'].TrimEnd('/'))/openai/deployments/$([uri]::EscapeDataString($aoaiDeployment))/chat/completions?api-version=$apiVersion"
        $body = @{ messages = @(@{ role = 'user'; content = 'Reply with the single word OK.' }) } | ConvertTo-Json -Depth 5
        try {
            Invoke-RestMethod -Method Post -Uri $uri -Headers @{ 'api-key' = $secretSettings['AZURE_OPENAI_API_KEY'] } -ContentType 'application/json' -Body $body -TimeoutSec 60 | Out-Null
        } catch {
            $status = $null
            if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
            # Azure's error text names the problem (unsupported model/API, bad parameter) and never echoes the key.
            $detail = ''
            if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
                try { $detail = (($_.ErrorDetails.Message | ConvertFrom-Json).error.message) } catch { $detail = $_.ErrorDetails.Message }
                if ($detail.Length -gt 400) { $detail = $detail.Substring(0, 400) }
                $detail = "$detail".TrimEnd('.', ' ')
            }
            $hint = switch ($status) {
                401 { 'The API key was rejected. Copy Key 1 from the resource''s Keys and Endpoint page into AZURE_OPENAI_API_KEY.' }
                404 { "No deployment named '$aoaiDeployment' at that endpoint, or the API version is too old. Check the deployment name in Foundry > Deployments." }
                { $_ -in 400, 422 } { "The deployment rejected an Azure OpenAI chat-completions request. Use a GPT chat model deployment (for example gpt-4.1-mini, gpt-4o-mini or gpt-5-mini); non-OpenAI Foundry models may not support this API." }
                429 { 'The deployment is rate-limited. Raise its tokens-per-minute in Foundry > Deployments, or wait and re-run.' }
                default { 'Check AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT, and that the resource allows public network access.' }
            }
            throw "Azure OpenAI call to deployment '$aoaiDeployment' failed$(if ($status) { " (HTTP $status)" })$(if ($detail) { ": $detail" }).`n$hint Re-run with -SkipModelCheck to deploy anyway."
        }
        Write-Host "    Model responded." -ForegroundColor Green
    }

    if (-not $SkipModelCheck -and $LlmProvider -eq 'Bedrock') {
        Write-Step "Checking Amazon Bedrock access to $ModelId"
        $probeFile = Join-Path $workDir 'bedrock-probe.json'
        Write-JsonFile $probeFile @{
            modelId         = $ModelId
            messages        = @(@{ role = 'user'; content = @(@{ text = 'Reply with the single word OK.' }) })
            inferenceConfig = @{ maxTokens = 512 }
        }
        $probe = Invoke-Aws @('bedrock-runtime', 'converse', '--cli-input-json', "file://$probeFile", '--output', 'json')
        if ($probe.ExitCode -ne 0) {
            $otherModel = if ($ModelId -match 'amazon\.nova') { "$GeoPrefix.anthropic.claude-sonnet-4-6" } else { "$GeoPrefix.amazon.nova-2-lite-v1:0" }
            $hint = "Pick a model you can use, e.g. -ModelId $otherModel, or list inference profiles with: aws bedrock list-inference-profiles --region $Region --query 'inferenceProfileSummaries[].inferenceProfileId'"
            if ($probe.Error -match 'being verified') {
                $hint = "New AWS accounts can't call Bedrock until AWS finishes verifying them (usually under 2 hours). Wait and re-run, or deploy now with -SkipModelCheck; the agent starts answering once verification completes."
            } elseif ($probe.Error -match 'not available for this account') {
                $hint = "This account can't use that model (new accounts often get the newest models later). Pick one it can use, e.g. -ModelId $GeoPrefix.anthropic.claude-sonnet-4-6 or -ModelId $GeoPrefix.amazon.nova-2-lite-v1:0."
            } elseif ($probe.Error -match 'use case|FTUFormNotFilled') {
                $hint = "Submit the Anthropic use-case form once for this account (Bedrock console > Model catalog > the Claude model; it can take 15 minutes to apply), or use -ModelId $GeoPrefix.amazon.nova-2-lite-v1:0."
            } elseif ($probe.Error -match 'aws-marketplace') {
                $hint = "The first call to a third-party model subscribes the account through AWS Marketplace; re-run as an identity with aws-marketplace:Subscribe and aws-marketplace:ViewSubscriptions."
            }
            throw "Bedrock call to '$ModelId' in $Region failed:`n$($probe.Error)`n$hint"
        }
        Write-Host "    Model responded." -ForegroundColor Green
    }

    # Setting names and role of the live revision (if any): -SettingsOnly reuses its role, and secret
    # settings an earlier deploy stored in the environment are removed (deploy keeps other variables).
    $live = Get-LiveRevisionInfo
    if ($TenantSecretPrefix -and $DisableMultiTenant) { throw "Pass either -TenantSecretPrefix or -DisableMultiTenant, not both." }
    # A multi-tenant backend serves every registered tenant; deploying it without the prefix would cut
    # them all off, so that has to be explicit.
    if (-not $TenantSecretPrefix -and -not $DisableMultiTenant -and $live -and ($live.SettingNames -contains 'A365_TENANT_SECRETS_PREFIX')) {
        throw ("'$FunctionName' is a multi-tenant backend. Re-run with -TenantSecretPrefix <prefix> (e.g. travelagent/tenants/) " +
            "to keep serving the registered tenants, or with -DisableMultiTenant to turn multi-tenant mode off.")
    }
    if ($SettingsOnly) {
        Write-Step "Checking Web Function '$FunctionName' (settings-only update)"
        $existing = Invoke-Aws @('lambda-web', 'get-web-function', '--function-name', $FunctionName, '--output', 'json')
        if ($existing.ExitCode -ne 0) {
            throw "Web Function '$FunctionName' wasn't found in $Region; run without -SettingsOnly to deploy it first.`n$($existing.Error)"
        }
        Write-Host "    Reusing the deployed code and execution role."
        # Code deployed before Secrets Manager support never reads A365_SECRETS_ARN, so moving its
        # secrets out of the environment would leave it without credentials while health and the
        # 401 check still pass. The first deploy after upgrading must ship the new code.
        if ($secretSettings.Count -gt 0 -and $live -and ($live.SettingNames -notcontains 'A365_SECRETS_ARN')) {
            throw ("The deployed code of '$FunctionName' predates Secrets Manager support (its settings have no A365_SECRETS_ARN). " +
                "Run a full deploy (without -SettingsOnly) first; later settings updates can use -SettingsOnly.")
        }
    }

    # --- 2. IAM execution role ----------------------------------------------------------------
    $roleName = "$FunctionName-exec"
    if ($roleName.Length -gt 64) { $roleName = $roleName.Substring(0, 64) }
    if ($SettingsOnly -and $live -and $live.RoleArn) { $roleName = ($live.RoleArn -split '/')[-1] }
    Write-Step "Ensuring IAM execution role $roleName"
    $roleCreated = $false
    $getRole = Invoke-Aws @('iam', 'get-role', '--role-name', $roleName, '--output', 'json')
    if ($getRole.ExitCode -eq 0) {
        $roleArn = ($getRole.Output | ConvertFrom-Json).Role.Arn
    } elseif ($getRole.Error -match 'NoSuchEntity' -and -not $SettingsOnly) {
        $trustFile = Join-Path $workDir 'trust-policy.json'
        Write-JsonFile $trustFile @{
            Version   = '2012-10-17'
            Statement = @(@{ Effect = 'Allow'; Principal = @{ Service = 'lambda.amazonaws.com' }; Action = 'sts:AssumeRole' })
        }
        $createRole = Invoke-Aws @('iam', 'create-role', '--role-name', $roleName, '--assume-role-policy-document', "file://$trustFile",
            '--description', "Execution role for the $FunctionName Lambda Web Function (Travel Agent AWS)", '--output', 'json')
        if ($createRole.ExitCode -ne 0) { throw "Could not create IAM role ${roleName}:`n$($createRole.Error)" }
        $roleArn = ($createRole.Output | ConvertFrom-Json).Role.Arn
        $attach = Invoke-Aws @('iam', 'attach-role-policy', '--role-name', $roleName,
            '--policy-arn', "arn:${partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole")
        if ($attach.ExitCode -ne 0) { throw "Could not attach the CloudWatch Logs policy to ${roleName}:`n$($attach.Error)" }
        $roleCreated = $true
    } else {
        throw "Could not read IAM role ${roleName}:`n$($getRole.Error)"
    }
    # Grants -ModelId only, and is rewritten on every run (including -SettingsOnly -ModelId ...).
    # A cross-Region inference profile (us./eu./global.) routes to foundation models in several
    # Regions, including the Region-less ARN global profiles use; the condition allows those only
    # when the call goes through the selected profile. InvokeSelectedModel covers a plain
    # foundation-model ID and is harmless for a profile ID.
    if ($LlmProvider -eq 'Bedrock') {
        $bedrockActions = @('bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream')
        if ($ModelId -like 'arn:*') {
            $profileArn = $ModelId
            $modelArn = $ModelId
        } else {
            $profileArn = "arn:${partition}:bedrock:${Region}:${accountId}:inference-profile/$ModelId"
            $modelArn = "arn:${partition}:bedrock:${Region}::foundation-model/$ModelId"
        }
        $bedrockPolicyFile = Join-Path $workDir 'bedrock-policy.json'
        Write-JsonFile $bedrockPolicyFile @{
            Version   = '2012-10-17'
            Statement = @(
                @{ Sid = 'InvokeSelectedProfile'; Effect = 'Allow'; Action = $bedrockActions; Resource = $profileArn },
                @{
                    Sid       = 'InvokeModelsThroughProfile'
                    Effect    = 'Allow'
                    Action    = $bedrockActions
                    Resource  = @("arn:${partition}:bedrock:*::foundation-model/*", "arn:${partition}:bedrock:::foundation-model/*")
                    Condition = @{ StringEquals = @{ 'bedrock:InferenceProfileArn' = $profileArn } }
                },
                @{ Sid = 'InvokeSelectedModel'; Effect = 'Allow'; Action = $bedrockActions; Resource = $modelArn }
            )
        }
        $putPolicy = Invoke-Aws @('iam', 'put-role-policy', '--role-name', $roleName, '--policy-name', 'bedrock-invoke',
            '--policy-document', "file://$bedrockPolicyFile")
        if ($putPolicy.ExitCode -ne 0) { throw "Could not grant Bedrock access to ${roleName}:`n$($putPolicy.Error)" }
    } else {
        # Azure OpenAI mode: the function doesn't call Bedrock, so drop any grant from a Bedrock deploy.
        $removePolicy = Invoke-Aws @('iam', 'delete-role-policy', '--role-name', $roleName, '--policy-name', 'bedrock-invoke')
        if ($removePolicy.ExitCode -ne 0 -and $removePolicy.Error -notmatch 'NoSuchEntity') {
            Write-Warning "Could not remove the bedrock-invoke policy from ${roleName}: $($removePolicy.Error)"
        }
    }
    Write-Host "    $roleArn"

    # --- 3. Agent 365 secrets: AWS Secrets Manager, never CLI arguments or function settings ---
    $grantedSecrets = $false
    if ($secretSettings.Count -gt 0) {
        Write-Step "Storing Agent 365 secrets in AWS Secrets Manager ($secretName)"
        $secretFile = Join-Path $workDir 'agent365-secrets.json'
        try {
            New-PrivateFile $secretFile
            Write-JsonFile $secretFile $secretSettings
            # Outputs of these calls hold only the ARN, name, and version, never the value.
            $describe = Invoke-Aws @('secretsmanager', 'describe-secret', '--secret-id', $secretName, '--output', 'json')
            if ($describe.ExitCode -eq 0) {
                if (($describe.Output | ConvertFrom-Json).DeletedDate) {
                    $restore = Invoke-Aws @('secretsmanager', 'restore-secret', '--secret-id', $secretName, '--output', 'json')
                    if ($restore.ExitCode -ne 0) { throw "Secret $secretName is scheduled for deletion and couldn't be restored:`n$($restore.Error)" }
                }
                $store = Invoke-Aws @('secretsmanager', 'put-secret-value', '--secret-id', $secretName,
                    '--secret-string', "file://$secretFile", '--output', 'json')
            } elseif ($describe.Error -match 'ResourceNotFoundException') {
                $store = Invoke-Aws @('secretsmanager', 'create-secret', '--name', $secretName,
                    '--description', "Agent 365 settings for $FunctionName", '--secret-string', "file://$secretFile", '--output', 'json')
            } else {
                throw "Could not read secret ${secretName}:`n$($describe.Error)"
            }
            if ($store.ExitCode -ne 0) { throw "Could not store the Agent 365 secrets in ${secretName}:`n$($store.Error)" }
            $secretArn = ($store.Output | ConvertFrom-Json).ARN
        } finally {
            Remove-Item -LiteralPath $secretFile -Force -ErrorAction SilentlyContinue
        }
        if (-not $secretArn) { throw "Secrets Manager returned no ARN for $secretName." }

        $hadSecretsGrant = (Invoke-Aws @('iam', 'get-role-policy', '--role-name', $roleName, '--policy-name', 'secrets-read', '--output', 'json')).ExitCode -eq 0
        $secretsPolicyFile = Join-Path $workDir 'secrets-policy.json'
        Write-JsonFile $secretsPolicyFile @{
            Version   = '2012-10-17'
            Statement = @(@{ Sid = 'ReadAgent365Secrets'; Effect = 'Allow'; Action = 'secretsmanager:GetSecretValue'; Resource = $secretArn })
        }
        $putSecretsPolicy = Invoke-Aws @('iam', 'put-role-policy', '--role-name', $roleName, '--policy-name', 'secrets-read',
            '--policy-document', "file://$secretsPolicyFile")
        if ($putSecretsPolicy.ExitCode -ne 0) { throw "Could not let ${roleName} read ${secretName}:`n$($putSecretsPolicy.Error)" }
        $grantedSecrets = -not $hadSecretsGrant
        $settings['A365_SECRETS_ARN'] = $secretArn
        Write-Host "    $secretArn"
    }

    # --- 3b. Multi-tenant registrations (register-tenant.ps1), read by the app at cold start ---
    if ($TenantSecretPrefix) {
        Write-Step "Checking tenant registrations under $TenantSecretPrefix"
        $listed = Invoke-Aws @('secretsmanager', 'list-secrets', '--filters', "Key=name,Values=$TenantSecretPrefix",
            '--query', 'SecretList[].Name', '--output', 'json')
        if ($listed.ExitCode -ne 0) { throw "Could not list secrets under ${TenantSecretPrefix}:`n$($listed.Error)" }
        $registered = @($listed.Output | ConvertFrom-Json | Where-Object { $_ -like "$TenantSecretPrefix*" })
        $baseConnections = @($settings.Keys | Where-Object { $_ -match '^connections__.+__settings__clientId$' }).Count
        Write-Host "    $($registered.Count) registered blueprints$(if ($baseConnections) { " + $baseConnections from $EnvFile" })"
        if ($registered.Count -eq 0 -and $baseConnections -eq 0) {
            throw "No blueprints to serve: register one with .\register-tenant.ps1 -SecretPrefix $TenantSecretPrefix, or add connection settings to $EnvFile."
        }
        $hadTenantGrant = (Invoke-Aws @('iam', 'get-role-policy', '--role-name', $roleName, '--policy-name', 'tenant-secrets-read', '--output', 'json')).ExitCode -eq 0
        $tenantPolicyFile = Join-Path $workDir 'tenant-secrets-policy.json'
        # BatchGetSecretValue with a name filter needs ListSecrets, which has no resource scope;
        # secret values stay readable only under the prefix.
        Write-JsonFile $tenantPolicyFile @{
            Version   = '2012-10-17'
            Statement = @(
                @{ Sid = 'FindTenantSecrets'; Effect = 'Allow'; Action = @('secretsmanager:ListSecrets', 'secretsmanager:BatchGetSecretValue'); Resource = '*' },
                @{ Sid = 'ReadTenantSecrets'; Effect = 'Allow'; Action = 'secretsmanager:GetSecretValue'
                   Resource = "arn:${partition}:secretsmanager:${Region}:${accountId}:secret:$TenantSecretPrefix*" }
            )
        }
        $putTenantPolicy = Invoke-Aws @('iam', 'put-role-policy', '--role-name', $roleName, '--policy-name', 'tenant-secrets-read',
            '--policy-document', "file://$tenantPolicyFile")
        if ($putTenantPolicy.ExitCode -ne 0) { throw "Could not let ${roleName} read ${TenantSecretPrefix}*:`n$($putTenantPolicy.Error)" }
        if (-not $hadTenantGrant) { $grantedSecrets = $true }
    } else {
        $removeTenantPolicy = Invoke-Aws @('iam', 'delete-role-policy', '--role-name', $roleName, '--policy-name', 'tenant-secrets-read')
        if ($removeTenantPolicy.ExitCode -ne 0 -and $removeTenantPolicy.Error -notmatch 'NoSuchEntity') {
            Write-Warning "Could not remove the tenant-secrets-read policy from ${roleName}: $($removeTenantPolicy.Error)"
        }
    }

    if ($roleCreated -or $grantedSecrets) {
        Write-Host "    $(if ($roleCreated) { 'New role' } else { 'New grant' }): waiting 15s for IAM propagation"
        Start-Sleep -Seconds 15
    }

    if (-not $SettingsOnly) {
        # --- 4. Build. Mirrored in aws/publish-launch-stack.ps1; keep the two in sync. ---------
        Write-Step "Building a production package (npm install --omit=dev + tsc)"
        $packageDir = Join-Path $workDir 'package'
        New-Item -ItemType Directory -Path $packageDir | Out-Null
        foreach ($file in 'package.json', 'package-lock.json', 'tsconfig.json', 'ToolingManifest.json') {
            if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination $packageDir }
        }
        Copy-Item -LiteralPath 'src' -Destination (Join-Path $packageDir 'src') -Recurse
        # Point "main" at the compiled Lambda entry (dist/lambda.js loads the require(esm) shim, then
        # the app) so the Lambda packager doesn't pick src/index.ts.
        $packageJsonPath = Join-Path $packageDir 'package.json'
        $packageJson = [IO.File]::ReadAllText($packageJsonPath) | ConvertFrom-Json
        $packageJson.main = 'dist/lambda.js'
        Write-JsonFile $packageJsonPath $packageJson

        Push-Location -Path $packageDir
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            & npm install --omit=dev --no-audit --no-fund --loglevel=error
            $npmExit = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previous
            Pop-Location
        }
        if ($npmExit -ne 0) { throw "npm install/build failed (exit $npmExit). See the output above." }
        if (-not (Test-Path -LiteralPath (Join-Path $packageDir 'dist/lambda.js'))) { throw "The build did not produce dist/lambda.js." }
        # typescript/@types are in dependencies so 'npm install --omit=dev' can compile via postinstall;
        # they're compile-time only, so drop them from the package.
        foreach ($buildOnly in 'src', 'node_modules/typescript', 'node_modules/@types') {
            $buildOnlyPath = Join-Path $packageDir $buildOnly
            if (Test-Path -LiteralPath $buildOnlyPath) { Remove-Item -LiteralPath $buildOnlyPath -Recurse -Force }
        }
        # Type declarations and source maps aren't used at runtime. They're about 60% of the files, and
        # the packager's zip time scales with file count.
        Get-ChildItem -LiteralPath $packageDir -Recurse -File -Force |
            Where-Object { $_.Name -match '\.(d\.[cm]?ts|map)$' } |
            Remove-Item -Force
        $sizeMb = [math]::Round(((Get-ChildItem -LiteralPath $packageDir -Recurse -File | Measure-Object -Property Length -Sum).Sum) / 1MB, 1)
        Write-Host "    Package size (unzipped): $sizeMb MB (limit 512 MB)"
        if ($sizeMb -gt 512) { throw "The package exceeds the 512 MB Lambda Web Functions limit." }
    }

    # --- 5. Deploy --------------------------------------------------------------------------
    Write-Step "Deploying Lambda Web Function '$FunctionName' (endpoint '$EndpointName')"
    $deployArgs = @('lambda-web', 'deploy', '--name', $FunctionName, '--endpoint-name', $EndpointName,
        '--timeout-seconds', "$TimeoutSeconds", '--revision-description', "Travel Agent AWS deploy $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')")
    # Without --code, the CLI publishes a revision that reuses the deployed code and role.
    if (-not $SettingsOnly) { $deployArgs += @('--code', $packageDir, '--create', '--execution-role-arn', $roleArn) }
    foreach ($key in $settings.Keys) { $deployArgs += @('--env', "$key=$($settings[$key])") }
    # Deploy keeps variables it isn't given, so drop secret settings an earlier deploy put in the
    # environment (names only; they now live in Secrets Manager).
    $staleSecretNames = @(if ($live) { $live.SettingNames | Where-Object { Test-SecretSettingName $_ } })
    if ($staleSecretNames) {
        Write-Host "    Removing secret settings from the function environment: $($staleSecretNames -join ', ')"
        foreach ($name in $staleSecretNames) { $deployArgs += @('--unset-env', $name) }
    }
    # Leaving multi-tenant mode (-DisableMultiTenant): drop the prefix with its tenant-secrets-read grant.
    if ($DisableMultiTenant -and $live -and ($live.SettingNames -contains 'A365_TENANT_SECRETS_PREFIX')) {
        Write-Host "    Turning off multi-tenant mode: removing A365_TENANT_SECRETS_PREFIX"
        $deployArgs += @('--unset-env', 'A365_TENANT_SECRETS_PREFIX')
    }
    # Called directly (not captured) so the CLI's progress streams to the console as it happens.
    & $AwsCli @deployArgs @AwsCommonArgs
    if ($LASTEXITCODE -ne 0) { throw "aws lambda-web deploy failed (exit $LASTEXITCODE). See the output above." }

    # Only names are queried, so no setting value is ever printed.
    $deployed = Get-LiveRevisionInfo
    $leakedSecretNames = @(if ($deployed) { $deployed.SettingNames | Where-Object { Test-SecretSettingName $_ } })
    if ($leakedSecretNames) {
        throw ("The deployed revision still has secret settings in its environment: $($leakedSecretNames -join ', '). " +
            "Remove them with: aws lambda-web deploy --name $FunctionName --endpoint-name $EndpointName --region $Region " +
            "$(($leakedSecretNames | ForEach-Object { "--unset-env $_" }) -join ' '), then rotate those secrets.")
    }

    $endpointResult = Invoke-Aws @('lambda-web', 'get-web-function-endpoint', '--function-name', $FunctionName,
        '--endpoint-name', $EndpointName, '--output', 'json')
    if ($endpointResult.ExitCode -ne 0) { throw "Could not read endpoint '$EndpointName':`n$($endpointResult.Error)" }
    $domain = ($endpointResult.Output | ConvertFrom-Json).domainName
    if (-not $domain) { throw "Endpoint '$EndpointName' has no domain name yet. Check it in the Lambda console." }
    $baseUrl = "https://$domain"
    $messagingEndpoint = "$baseUrl/api/messages"

    # --- 6. Verify --------------------------------------------------------------------------
    Write-Step "Waiting for $baseUrl/api/health"
    $healthy = $false
    for ($i = 1; $i -le 24; $i++) {
        if ((Get-HttpStatus { Invoke-WebRequest -Uri "$baseUrl/api/health" -UseBasicParsing -TimeoutSec 20 }) -eq 200) {
            $healthy = $true
            break
        }
        Write-Host "    ...not ready yet (attempt $i)"
        Start-Sleep -Seconds 5
    }
    if (-not $healthy) {
        throw "The function didn't become healthy. Check startup errors with: aws logs tail /aws/lambda/web/$FunctionName --since 15m --region $Region"
    }
    Write-Host "    Health check returned 200." -ForegroundColor Green

    $authStatus = Get-HttpStatus {
        Invoke-WebRequest -Uri $messagingEndpoint -Method Post -Body '{}' -ContentType 'application/json' -UseBasicParsing -TimeoutSec 30
    }
    if ($authStatus -eq 401) {
        Write-Host "    /api/messages rejects unauthenticated calls (401), as expected." -ForegroundColor Green
    } elseif ($authStatus -ge 200 -and $authStatus -lt 300) {
        # Fail before -UpdateA365Endpoint can point the blueprint at an open endpoint.
        throw ("/api/messages accepted an unauthenticated call (HTTP $authStatus) on a public endpoint. " +
            "Check the connections__*__settings__* values in $EnvFile and re-run, or remove the function: " +
            "aws lambda-web delete-web-function --function-name $FunctionName --region $Region")
    } else {
        Write-Warning "/api/messages returned $authStatus to an unauthenticated call (expected 401). Check the connection settings in $EnvFile."
    }

    # --- 7. Agent 365 messaging endpoint --------------------------------------------------------
    if ($UpdateA365Endpoint) {
        Write-Step "Pointing the Agent 365 blueprint at $messagingEndpoint"
        $a365Command = "a365 setup blueprint --update-endpoint $messagingEndpoint --m365"
        if (-not (Get-Command a365 -ErrorAction SilentlyContinue)) { throw "Agent 365 CLI (a365) not found. Install it, then run: $a365Command" }
        if (-not (Test-Path -LiteralPath 'a365.config.json')) { throw "a365.config.json not found in $PSScriptRoot. From your a365 project folder, run: $a365Command" }
        # --m365 re-registers the endpoint with Teams; older a365 versions skip that step without it.
        & a365 setup blueprint --update-endpoint $messagingEndpoint --m365
        if ($LASTEXITCODE -ne 0) {
            $blueprintId = '<agentBlueprintId>'
            if (Test-Path -LiteralPath 'a365.generated.config.json') {
                $generated = [IO.File]::ReadAllText((Resolve-Path 'a365.generated.config.json')) | ConvertFrom-Json
                if ($generated.agentBlueprintId) { $blueprintId = $generated.agentBlueprintId }
            }
            throw ("'$a365Command' failed (exit $LASTEXITCODE); the AWS deployment itself succeeded. " +
                "Only blueprint owners can change the messaging endpoint; if you aren't one, have an owner or a Global Administrator run " +
                "'az ad app owner add --id $blueprintId --owner-object-id <your-object-id>' (az ad signed-in-user show --query id), then re-run the a365 command.")
        }
    }

    Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue

    $consoleUrl = "https://$Region.console.aws.amazon.com/lambda/home?region=$Region"
    Write-Host ""
    Write-Host "==> Deployed to AWS." -ForegroundColor Green
    Write-Host "    Messaging endpoint: $messagingEndpoint"
    if ($LlmProvider -eq 'AzureOpenAI') {
        Write-Host "    LLM:                Azure OpenAI deployment $($settings['AZURE_OPENAI_DEPLOYMENT'])"
    } else {
        Write-Host "    LLM:                Amazon Bedrock $ModelId ($Region)"
    }
    Write-Host "    Console:            $consoleUrl > Web Functions (not Functions) > $FunctionName"
    Write-Host "    Logs:               aws logs tail /aws/lambda/web/$FunctionName --follow --region $Region"
    if (-not $UpdateA365Endpoint) {
        Write-Host ""
        Write-Host "    To route the Teams agent here, run (or re-run this script with -UpdateA365Endpoint):" -ForegroundColor Yellow
        Write-Host "      a365 setup blueprint --update-endpoint $messagingEndpoint --m365" -ForegroundColor Yellow
    }

    if ($TailLogs) {
        Write-Step "Streaming application logs (Ctrl+C to stop)"
        & $AwsCli logs tail "/aws/lambda/web/$FunctionName" --follow @AwsCommonArgs
    }
} catch {
    # Print the actionable message once, without PowerShell's script position and error-record noise.
    Write-Host ""
    Write-Host "Deployment stopped: $($_.Exception.Message)" -ForegroundColor Red
    $deployFailed = $true
} finally {
    if ($workDir) { Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue }
    Pop-Location
}

if ($deployFailed) { exit 1 }
