# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    Publishes Travel Agent AWS for one-click AWS deployment: builds the code package once, uploads it
    with the CloudFormation template, and prints "Launch Stack" links.

.DESCRIPTION
    For whoever maintains the deployment; run it once per release. The people who deploy only need
    a printed link and an AWS console sign-in: no tools, no files, no terminal.

      1. Builds the production package (npm install --omit=dev, which runs tsc), the same way
         deploy-aws.ps1 does, and zips it.
      2. Uploads package.zip and the template (with its PackageUrl and PackageSha256 defaults filled
         in) to s3://<Bucket>/travelagentdw/<Version>/, creating the bucket (private, versioned) if
         needed. Deployments refuse a package whose SHA-256 doesn't match the template.
      3. Shares exactly those two files according to -Share. The bucket policy is merged: other
         versions and unrelated statements keep their access.
      4. Prints a Launch Stack link for each Region that has Lambda Web Functions.

    Each deployment copies the package into its own S3 bucket, so new releases, or deleting old
    ones from -Bucket, don't affect agents that are already deployed.

.PARAMETER Share
    Who can use this version's links (other versions keep the access they were published with):
      Account       only this AWS account (default; use it to test). Withdraws an earlier
                    Organization or Public grant for this version only.
      Organization  every account in your AWS Organization; requires -OrganizationId
      Public        anyone with the link. The package and template contain no secrets: each person
                    enters their agent's values when they deploy.

.PARAMETER OrganizationId
    Your AWS Organization ID (o-...), for -Share Organization. Find it with:
    aws organizations describe-organization --query Organization.Id

.PARAMETER Bucket
    S3 bucket for releases. Default: travelagentdw-releases-<account-id>-<region>.

.PARAMETER Version
    Release folder name. Default: the current UTC date and time (yyyyMMdd-HHmmss).

.PARAMETER Region
    Region for the bucket. Default: AWS_REGION, AWS_DEFAULT_REGION, or the AWS CLI profile's
    Region, else us-east-1. The links work in every Web Functions Region regardless.

.PARAMETER AwsProfile
    AWS CLI profile to use.

.PREREQUISITES
    - AWS CLI v2, signed in (`aws login`, `aws configure sso`, or `aws configure`) to the account
      that hosts the releases
    - Node.js 24+ and npm

.EXAMPLE
    ./aws/publish-launch-stack.ps1
    ./aws/publish-launch-stack.ps1 -Share Public
    ./aws/publish-launch-stack.ps1 -Share Organization -OrganizationId o-a1b2c3d4e5
#>

[CmdletBinding()]
param(
    [ValidateSet('Account', 'Organization', 'Public')]
    [string]$Share = 'Account',
    [ValidatePattern('^o-[a-z0-9]{10,32}$')]
    [string]$OrganizationId,
    [ValidatePattern('^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$')]
    [string]$Bucket,
    [ValidatePattern('^[A-Za-z0-9._-]{1,64}$')]
    [string]$Version = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss'),
    [string]$Region,
    [string]$AwsProfile
)

$ErrorActionPreference = 'Stop'
# Native tools (aws, npm) report failure through exit codes, which this script checks itself.
$PSNativeCommandUseErrorActionPreference = $false

$WebFunctionRegions = @('us-east-1', 'us-east-2', 'us-west-2', 'eu-west-1', 'ap-northeast-1')
$KeyPrefix = 'travelagentdw'
$PackageUrlPlaceholder = "Default: ''  # set by aws/publish-launch-stack.ps1"
$PackageShaPlaceholder = "Default: ''  # SHA-256, set by aws/publish-launch-stack.ps1"

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

function Resolve-AwsCli {
    $cmd = Get-Command aws -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    # winget/MSI installs aren't on PATH until a new terminal is opened.
    foreach ($candidate in @("$env:ProgramFiles\Amazon\AWSCLIV2\aws.exe", "$env:LOCALAPPDATA\Programs\Amazon\AWSCLIV2\aws.exe")) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    throw "AWS CLI v2 not found. Install it (Windows: winget install Amazon.AWSCLI, others: https://aws.amazon.com/cli/) and re-run."
}

# Runs the AWS CLI with the common --region/--profile flags and captures its output.
function Invoke-Aws {
    param([Parameter(Mandatory)][string[]]$Arguments, [string[]]$CommonArgs = $script:AwsCommonArgs)
    $allArgs = $Arguments + $CommonArgs
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

if ($Share -eq 'Organization' -and -not $OrganizationId) {
    throw "-Share Organization requires -OrganizationId (find it with: aws organizations describe-organization --query Organization.Id)."
}
if ($OrganizationId -and $Share -ne 'Organization') { throw "-OrganizationId is only used with -Share Organization." }

$projectDir = Split-Path -Parent $PSScriptRoot
$templatePath = Join-Path $PSScriptRoot 'travelagentdw.cfn.yaml'
if (-not (Test-Path -LiteralPath $templatePath)) { throw "Template not found: $templatePath" }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm not found. Install Node.js 24+ (https://nodejs.org/) and re-run." }

$AwsCli = Resolve-AwsCli
if (-not $Region) { $Region = @($env:AWS_REGION, $env:AWS_DEFAULT_REGION) | Where-Object { $_ } | Select-Object -First 1 }
if (-not $Region) {
    $profileArgs = @()
    if ($AwsProfile) { $profileArgs = @('--profile', $AwsProfile) }
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $Region = & $AwsCli configure get region @profileArgs 2>$null | Select-Object -First 1
    $ErrorActionPreference = $previous
}
if (-not $Region) { $Region = 'us-east-1' }
$Region = "$Region".Trim()
if ($Region -notmatch '^[a-z]{2}(-[a-z]+)+-\d+$') { throw "'$Region' isn't a valid AWS Region. Pass one with -Region, e.g. -Region us-east-1." }
$AwsCommonArgs = @('--region', $Region, '--no-cli-pager')
if ($AwsProfile) { $AwsCommonArgs += @('--profile', $AwsProfile) }

$workDir = Join-Path ([IO.Path]::GetTempPath()) "travelagentdw-publish-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
New-Item -ItemType Directory -Path $workDir | Out-Null
$started = Get-Date
try {
    Write-Step "Checking AWS sign-in"
    $identityResult = Invoke-Aws @('sts', 'get-caller-identity', '--output', 'json')
    if ($identityResult.ExitCode -ne 0) {
        throw "Not signed in to AWS. Run 'aws login' (or 'aws configure sso' / 'aws configure'), then re-run.`n$($identityResult.Error)"
    }
    $identity = $identityResult.Output | ConvertFrom-Json
    $accountId = $identity.Account
    $partition = ($identity.Arn -split ':')[1]
    if (-not $Bucket) { $Bucket = "travelagentdw-releases-$accountId-$Region" }
    Write-Host "    Account $accountId, bucket $Bucket ($Region)"

    # --- 1. Build. Mirrors the build in deploy-aws.ps1; keep the two in sync. --------------------
    Write-Step "Building the production package (npm install --omit=dev + tsc)"
    $packageDir = Join-Path $workDir 'package'
    New-Item -ItemType Directory -Path $packageDir | Out-Null
    foreach ($file in 'package.json', 'package-lock.json', 'tsconfig.json', 'ToolingManifest.json') {
        $source = Join-Path $projectDir $file
        if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $packageDir }
    }
    Copy-Item -LiteralPath (Join-Path $projectDir 'src') -Destination (Join-Path $packageDir 'src') -Recurse
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
    Get-ChildItem -LiteralPath $packageDir -Recurse -File -Force |
        Where-Object { $_.Name -match '\.(d\.[cm]?ts|map)$' } |
        Remove-Item -Force
    $sizeMb = [math]::Round(((Get-ChildItem -LiteralPath $packageDir -Recurse -File | Measure-Object -Property Length -Sum).Sum) / 1MB, 1)
    if ($sizeMb -gt 512) { throw "The package is $sizeMb MB unzipped, over the 512 MB Lambda Web Functions limit." }

    $zipPath = Join-Path $workDir 'package.zip'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($packageDir, $zipPath, [IO.Compression.CompressionLevel]::Optimal, $false)
    $zipMb = [math]::Round((Get-Item -LiteralPath $zipPath).Length / 1MB, 1)
    $packageSha256 = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host "    package.zip: $zipMb MB ($sizeMb MB unzipped)"

    # --- 2. Upload ----------------------------------------------------------------------------
    Write-Step "Uploading the release to s3://$Bucket/$KeyPrefix/$Version/"
    $head = Invoke-Aws @('s3api', 'head-bucket', '--bucket', $Bucket)
    if ($head.ExitCode -ne 0) {
        if ($head.Error -notmatch '404|Not Found|NoSuchBucket') {
            throw "Can't use bucket '$Bucket' (it may belong to another account). Pass a different -Bucket.`n$($head.Error)"
        }
        $createArgs = @('s3api', 'create-bucket', '--bucket', $Bucket)
        if ($Region -ne 'us-east-1') { $createArgs += @('--create-bucket-configuration', "LocationConstraint=$Region") }
        $create = Invoke-Aws $createArgs
        if ($create.ExitCode -ne 0) { throw "Could not create bucket ${Bucket}:`n$($create.Error)" }
        $versioning = Invoke-Aws @('s3api', 'put-bucket-versioning', '--bucket', $Bucket, '--versioning-configuration', 'Status=Enabled')
        if ($versioning.ExitCode -ne 0) { throw "Could not enable versioning on ${Bucket}:`n$($versioning.Error)" }
        Write-Host "    Created bucket $Bucket (private, versioned)"
    }

    $packageKey = "$KeyPrefix/$Version/package.zip"
    $templateKey = "$KeyPrefix/$Version/template.yaml"
    $baseUrl = "https://$Bucket.s3.$Region.amazonaws.com"
    $packageUrl = "$baseUrl/$packageKey"
    $templateUrl = "$baseUrl/$templateKey"

    $templateText = [IO.File]::ReadAllText($templatePath)
    foreach ($placeholder in $PackageUrlPlaceholder, $PackageShaPlaceholder) {
        if (([regex]::Matches($templateText, [regex]::Escape($placeholder))).Count -ne 1) {
            throw "Expected exactly one $placeholder in $templatePath."
        }
    }
    $releaseTemplatePath = Join-Path $workDir 'template.yaml'
    [IO.File]::WriteAllText($releaseTemplatePath, $templateText.Replace($PackageUrlPlaceholder, "Default: '$packageUrl'").Replace($PackageShaPlaceholder, "Default: '$packageSha256'"))

    foreach ($upload in @(@($zipPath, $packageKey), @($releaseTemplatePath, $templateKey))) {
        $copy = Invoke-Aws @('s3', 'cp', $upload[0], "s3://$Bucket/$($upload[1])", '--only-show-errors')
        if ($copy.ExitCode -ne 0) { throw "Upload of $($upload[1]) failed:`n$($copy.Error)" }
    }
    $validate = Invoke-Aws @('cloudformation', 'validate-template', '--template-url', $templateUrl, '--output', 'json')
    if ($validate.ExitCode -ne 0) { throw "CloudFormation rejected the template:`n$($validate.Error)" }

    # --- 3. Share -----------------------------------------------------------------------------
    # Grants cover exactly this version's two files, and the existing bucket policy is merged so
    # other versions and unrelated statements keep their access.
    Write-Step "Sharing the release ($Share)"
    $releaseObjects = @("arn:${partition}:s3:::$Bucket/$packageKey", "arn:${partition}:s3:::$Bucket/$templateKey")
    # Sid must be alphanumeric and -Version may contain . _ -, so key this version's statements by a hash.
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $versionHash = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Version)) | ForEach-Object { $_.ToString('x2') })
    } finally {
        $sha.Dispose()
    }
    $sidPrefix = 'TravelAgentRelease' + $versionHash.Substring(0, 12)
    $keptStatements = @()
    $currentPolicy = Invoke-Aws @('s3api', 'get-bucket-policy', '--bucket', $Bucket, '--output', 'json')
    if ($currentPolicy.ExitCode -eq 0) {
        $current = ($currentPolicy.Output | ConvertFrom-Json).Policy | ConvertFrom-Json
        foreach ($statement in @($current.Statement)) {
            $sid = [string]$statement.Sid
            # HttpsOnly is re-added below; this version's earlier grant is replaced.
            if ($sid -eq 'HttpsOnly' -or $sid.StartsWith($sidPrefix)) { continue }
            if ($sid -eq 'OrganizationRead' -or $sid -eq 'PublicRead') {
                Write-Warning "Removed the '$sid' statement an earlier version of this script wrote: it exposed every release under $KeyPrefix/. Re-run this script for each older version that should stay shared."
                continue
            }
            $keptStatements += $statement
        }
    } elseif ($currentPolicy.Error -notmatch 'NoSuchBucketPolicy') {
        throw "Could not read the bucket policy of ${Bucket}:`n$($currentPolicy.Error)"
    }
    $statements = @(@{
        Sid       = 'HttpsOnly'
        Effect    = 'Deny'
        Principal = '*'
        Action    = 's3:*'
        Resource  = @("arn:${partition}:s3:::$Bucket", "arn:${partition}:s3:::$Bucket/*")
        Condition = @{ Bool = @{ 'aws:SecureTransport' = 'false' } }
    }) + $keptStatements
    switch ($Share) {
        'Organization' {
            $statements += @{
                Sid = "${sidPrefix}Org"; Effect = 'Allow'; Principal = '*'; Action = 's3:GetObject'; Resource = $releaseObjects
                Condition = @{ StringEquals = @{ 'aws:PrincipalOrgID' = $OrganizationId } }
            }
        }
        'Public' {
            # Allow a public bucket policy on this bucket only; ACLs stay blocked. Not reverted for
            # Account, because other versions may still be public.
            $pab = Invoke-Aws @('s3api', 'put-public-access-block', '--bucket', $Bucket, '--public-access-block-configuration',
                'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false')
            if ($pab.ExitCode -ne 0) { throw "Could not allow a public policy on ${Bucket}:`n$($pab.Error)" }
            $statements += @{ Sid = "${sidPrefix}Public"; Effect = 'Allow'; Principal = '*'; Action = 's3:GetObject'; Resource = $releaseObjects }
        }
    }
    $policyFile = Join-Path $workDir 'bucket-policy.json'
    Write-JsonFile $policyFile @{ Version = '2012-10-17'; Statement = $statements }
    $policy = Invoke-Aws @('s3api', 'put-bucket-policy', '--bucket', $Bucket, '--policy', "file://$policyFile")
    if ($policy.ExitCode -ne 0) {
        $hint = ''
        if ($policy.Error -match 'BlockPublicPolicy|public policies') {
            $hint = "`nThis account blocks public bucket policies (S3 > Block Public Access settings for this account). Allow them, or use -Share Organization."
        }
        throw "Could not set the bucket policy on ${Bucket}:`n$($policy.Error)$hint"
    }

    # CloudFormation in other Regions reads the template from this bucket; check one.
    $otherRegion = $WebFunctionRegions | Where-Object { $_ -ne $Region } | Select-Object -First 1
    $crossRegion = Invoke-Aws @('cloudformation', 'validate-template', '--template-url', $templateUrl, '--output', 'json') -CommonArgs (@('--region', $otherRegion, '--no-cli-pager') + $(if ($AwsProfile) { @('--profile', $AwsProfile) } else { @() }))
    if ($crossRegion.ExitCode -ne 0) {
        Write-Warning "CloudFormation in $otherRegion couldn't read the template. Links for Regions other than $Region may not work:`n$($crossRegion.Error)"
    }

    # --- 4. Links -----------------------------------------------------------------------------
    $minutes = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)
    Write-Host ""
    Write-Host "==> Published release $Version in $minutes min." -ForegroundColor Green
    Write-Host "    Template: $templateUrl"
    Write-Host "    Package:  $packageUrl"
    Write-Host "    SHA-256:  $packageSha256"
    Write-Host ""
    Write-Host "    Launch Stack links (open the one for your Region, sign in, fill in the 3 Agent 365 values):"
    foreach ($linkRegion in $WebFunctionRegions) {
        $link = "https://$linkRegion.console.aws.amazon.com/cloudformation/home?region=$linkRegion#/stacks/quickcreate" +
            "?templateURL=$([uri]::EscapeDataString($templateUrl))&stackName=travelagentdw"
        Write-Host ("      {0,-15} {1}" -f $linkRegion, $link)
    }
    Write-Host ""
    switch ($Share) {
        'Account' { Write-Host "    This version is shared with this account only. To let other accounts deploy it, re-run with -Version $Version and -Share Public or -Share Organization -OrganizationId o-..." -ForegroundColor Yellow }
        'Organization' { Write-Host "    Usable from every account in $OrganizationId. To deploy to many accounts at once, use CloudFormation StackSets with the template URL above (see README)." }
        'Public' { Write-Host "    Anyone with a link can deploy. Each deployment copies the package into its own account." }
    }
}
finally {
    Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
}
