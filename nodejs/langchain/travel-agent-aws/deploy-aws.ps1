# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    One-click deploy of the TravelAgentDW messaging endpoint to AWS
    (AWS Lambda Web Functions + Amazon Bedrock).

.DESCRIPTION
    Runs the agent as an AWS Lambda Web Function (a managed Node.js HTTP server with a
    built-in HTTPS endpoint) and points the LLM at Amazon Bedrock through the function's
    IAM execution role, so no model keys are stored anywhere. Safe to re-run: the first run
    creates everything, later runs publish a new revision behind the same URL.

      1. Checks the AWS CLI (v2 with `lambda-web`), your AWS sign-in, and Bedrock access to -ModelId.
      2. Creates or updates the IAM execution role (CloudWatch Logs + Bedrock InvokeModel).
      3. Builds a production-only package (npm install --omit=dev, which runs tsc) in a temp folder.
      4. Runs `aws lambda-web deploy`, passing the settings in -EnvFile as environment variables.
      5. Waits for /api/health and confirms /api/messages rejects unauthenticated calls.
      6. With -UpdateA365Endpoint, points the Agent 365 blueprint at the new URL
         (`a365 setup blueprint --update-endpoint <url>/api/messages --m365`).

    With -SettingsOnly, steps 2 and 3 are skipped: the settings in -EnvFile are published as a new
    revision that reuses the deployed code, for example after `a365 setup` writes new blueprint
    credentials to .env.

.PREREQUISITES
    - AWS CLI v2 with `aws lambda-web` (2.38+), signed in: `aws login`, `aws configure sso`, or `aws configure`
    - Node.js 24+ and npm
    - A .env with the agent's Agent 365 settings (written by `a365 setup all --aiteammate --m365`)
    - Amazon Bedrock access to -ModelId in -Region. The default, Amazon Nova 2 Lite, needs no extra
      sign-up; Anthropic Claude models need the one-time Anthropic use-case form first.
    - For -UpdateA365Endpoint: the Agent 365 CLI (`a365`), a365.config.json in this folder, and
      owner rights on the agent blueprint

.EXAMPLE
    ./deploy-aws.ps1
    ./deploy-aws.ps1 -UpdateA365Endpoint
    ./deploy-aws.ps1 -SettingsOnly
    ./deploy-aws.ps1 -Region us-west-2 -ModelId us.anthropic.claude-sonnet-4-6 -AwsProfile my-sso
#>

[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,62}[A-Za-z0-9]$')]
    [string]$FunctionName = 'travelagentdw',
    [string]$Region,
    [string]$ModelId,
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

# .env keys that must not be shipped: AWS-reserved names and credentials, the Azure/OpenAI
# LLM settings this deployment replaces with Bedrock, local-dev-only switches, and the
# values this script sets itself.
$ExcludedSettingsPattern = '^(AWS_|LAMBDA_|_|AZURE_OPENAI_|OPENAI_|WEBSITE_|SCM_)|^(PORT|NODE_ENV|BEARER_TOKEN|ENABLE_TEST_ENDPOINT|LLM_PROVIDER|BEDROCK_MODEL_ID|BEDROCK_REGION)$'

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
    $errFile = [IO.Path]::GetTempFileName()
    try {
        $stdout = & $script:AwsCli @allArgs 2> $errFile
        $exitCode = $LASTEXITCODE
        $stderr = [IO.File]::ReadAllText($errFile)
    } finally {
        Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
        $ErrorActionPreference = $previous
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = (@($stdout) -join "`n"); Error = $stderr.Trim() }
}

function Write-JsonFile([string]$Path, $Object) {
    # UTF-8 without BOM: the AWS CLI rejects file:// JSON that starts with a BOM.
    [IO.File]::WriteAllText($Path, ($Object | ConvertTo-Json -Depth 20 -Compress))
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
    $skipped = @()
    $dotEnv = Read-DotEnv $EnvFile
    foreach ($key in $dotEnv.Keys) {
        $value = $dotEnv[$key]
        if ($key -match $ExcludedSettingsPattern -or [string]::IsNullOrEmpty($value)) { $skipped += $key; continue }
        if ($key -notmatch '^[A-Za-z][A-Za-z0-9_]*$') { Write-Warning "Skipping '$key': AWS environment variable names allow only letters, digits, and underscores."; continue }
        if ($value.Contains('"')) { throw "The value of '$key' in $EnvFile contains a double quote, which can't be passed safely to the AWS CLI." }
        $settings[$key] = $value
    }
    if (-not ($settings.Keys | Where-Object { $_ -match '^connections__.+__settings__clientId$' })) {
        throw "$EnvFile has no Agent 365 connection settings (connections__<name>__settings__clientId). Run 'a365 setup all --aiteammate --m365' first."
    }
    $settings['NODE_ENV'] = 'production'
    $settings['LLM_PROVIDER'] = 'bedrock'
    $settings['BEDROCK_MODEL_ID'] = $ModelId
    $settings['BEDROCK_REGION'] = $Region
    # The packager only accepts the entry point together with --code; settings-only updates keep it.
    if (-not $SettingsOnly) { $settings['AWS_LAMBDA_NODEJS_ENTRYPOINT'] = 'dist/lambda.js' }
    Write-Host "    Passing $($settings.Count) settings; not shipping: $(if ($skipped) { $skipped -join ', ' } else { '(none)' })"

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

    $workDir = Join-Path ([IO.Path]::GetTempPath()) "$FunctionName-aws-deploy"
    if (Test-Path -LiteralPath $workDir) { Remove-Item -LiteralPath $workDir -Recurse -Force }
    New-Item -ItemType Directory -Path $workDir | Out-Null

    if (-not $SkipModelCheck) {
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

    if (-not $SettingsOnly) {
        # --- 2. IAM execution role ----------------------------------------------------------------
        $roleName = "$FunctionName-exec"
        if ($roleName.Length -gt 64) { $roleName = $roleName.Substring(0, 64) }
        Write-Step "Ensuring IAM execution role $roleName"
        $roleCreated = $false
        $getRole = Invoke-Aws @('iam', 'get-role', '--role-name', $roleName, '--output', 'json')
        if ($getRole.ExitCode -eq 0) {
            $roleArn = ($getRole.Output | ConvertFrom-Json).Role.Arn
        } elseif ($getRole.Error -match 'NoSuchEntity') {
            $trustFile = Join-Path $workDir 'trust-policy.json'
            Write-JsonFile $trustFile @{
                Version   = '2012-10-17'
                Statement = @(@{ Effect = 'Allow'; Principal = @{ Service = 'lambda.amazonaws.com' }; Action = 'sts:AssumeRole' })
            }
            $createRole = Invoke-Aws @('iam', 'create-role', '--role-name', $roleName, '--assume-role-policy-document', "file://$trustFile",
                '--description', "Execution role for the $FunctionName Lambda Web Function (TravelAgentDW)", '--output', 'json')
            if ($createRole.ExitCode -ne 0) { throw "Could not create IAM role ${roleName}:`n$($createRole.Error)" }
            $roleArn = ($createRole.Output | ConvertFrom-Json).Role.Arn
            $attach = Invoke-Aws @('iam', 'attach-role-policy', '--role-name', $roleName,
                '--policy-arn', "arn:${partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole")
            if ($attach.ExitCode -ne 0) { throw "Could not attach the CloudWatch Logs policy to ${roleName}:`n$($attach.Error)" }
            $roleCreated = $true
        } else {
            throw "Could not read IAM role ${roleName}:`n$($getRole.Error)"
        }
        # Cross-Region inference profiles (us./eu./global.) also need the foundation-model ARNs of every
        # destination Region, including the Region-less ARN used by global profiles.
        $bedrockPolicyFile = Join-Path $workDir 'bedrock-policy.json'
        Write-JsonFile $bedrockPolicyFile @{
            Version   = '2012-10-17'
            Statement = @(@{
                Sid      = 'InvokeBedrockModels'
                Effect   = 'Allow'
                Action   = @('bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream')
                Resource = @(
                    "arn:${partition}:bedrock:*::foundation-model/*",
                    "arn:${partition}:bedrock:::foundation-model/*",
                    "arn:${partition}:bedrock:*:${accountId}:inference-profile/*",
                    "arn:${partition}:bedrock:*:${accountId}:application-inference-profile/*"
                )
            })
        }
        $putPolicy = Invoke-Aws @('iam', 'put-role-policy', '--role-name', $roleName, '--policy-name', 'bedrock-invoke',
            '--policy-document', "file://$bedrockPolicyFile")
        if ($putPolicy.ExitCode -ne 0) { throw "Could not grant Bedrock access to ${roleName}:`n$($putPolicy.Error)" }
        Write-Host "    $roleArn"
        if ($roleCreated) {
            Write-Host "    New role: waiting 15s for IAM propagation"
            Start-Sleep -Seconds 15
        }

        # --- 3. Build. Mirrored in aws/publish-launch-stack.ps1; keep the two in sync. ---------
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
        # typescript/@types are listed under dependencies for Azure's Oryx build but are compile-time only.
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
    } else {
        Write-Step "Checking Web Function '$FunctionName' (settings-only update)"
        $existing = Invoke-Aws @('lambda-web', 'get-web-function', '--function-name', $FunctionName, '--output', 'json')
        if ($existing.ExitCode -ne 0) {
            throw "Web Function '$FunctionName' wasn't found in $Region; run without -SettingsOnly to deploy it first.`n$($existing.Error)"
        }
        Write-Host "    Reusing the deployed code and execution role."
    }

    # --- 4. Deploy --------------------------------------------------------------------------
    Write-Step "Deploying Lambda Web Function '$FunctionName' (endpoint '$EndpointName')"
    $deployArgs = @('lambda-web', 'deploy', '--name', $FunctionName, '--endpoint-name', $EndpointName,
        '--timeout-seconds', "$TimeoutSeconds", '--revision-description', "TravelAgentDW deploy $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')")
    # Without --code, the CLI publishes a revision that reuses the deployed code and role.
    if (-not $SettingsOnly) { $deployArgs += @('--code', $packageDir, '--create', '--execution-role-arn', $roleArn) }
    foreach ($key in $settings.Keys) { $deployArgs += @('--env', "$key=$($settings[$key])") }
    # Called directly (not captured) so the CLI's progress streams to the console as it happens.
    & $AwsCli @deployArgs @AwsCommonArgs
    if ($LASTEXITCODE -ne 0) { throw "aws lambda-web deploy failed (exit $LASTEXITCODE). See the output above." }

    $endpointResult = Invoke-Aws @('lambda-web', 'get-web-function-endpoint', '--function-name', $FunctionName,
        '--endpoint-name', $EndpointName, '--output', 'json')
    if ($endpointResult.ExitCode -ne 0) { throw "Could not read endpoint '$EndpointName':`n$($endpointResult.Error)" }
    $domain = ($endpointResult.Output | ConvertFrom-Json).domainName
    if (-not $domain) { throw "Endpoint '$EndpointName' has no domain name yet. Check it in the Lambda console." }
    $baseUrl = "https://$domain"
    $messagingEndpoint = "$baseUrl/api/messages"

    # --- 5. Verify --------------------------------------------------------------------------
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
    } else {
        Write-Warning "/api/messages returned $authStatus to an unauthenticated call (expected 401). Check the connection settings in $EnvFile."
    }

    # --- 6. Agent 365 messaging endpoint --------------------------------------------------------
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
    Write-Host "    LLM:                Amazon Bedrock $ModelId ($Region)"
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
} finally {
    Pop-Location
}
