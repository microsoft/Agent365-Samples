$ErrorActionPreference = 'Stop'

$workspace = Get-Location
$playgroundEnvPath = Join-Path $workspace 'env/.env.playground'
$playgroundUserEnvPath = Join-Path $workspace 'env/.env.playground.user'

$a365Command = Get-Command a365 -ErrorAction SilentlyContinue
if (-not $a365Command) {
    throw "a365 CLI is not installed or not on PATH. Install with: dotnet tool install --global Microsoft.Agents.A365.DevTools.Cli"
}

if (-not (Test-Path $playgroundEnvPath)) {
    throw "Missing env file: $playgroundEnvPath"
}

$appIdLine = Get-Content $playgroundEnvPath | Where-Object { $_ -match '^\s*CLIENT_APP_ID\s*=\s*.+$' } | Select-Object -First 1
if (-not $appIdLine) {
    throw "CLIENT_APP_ID is required in env/.env.playground"
}

$appId = ($appIdLine -split '=', 2)[1].Trim()
if ([string]::IsNullOrWhiteSpace($appId)) {
    throw "CLIENT_APP_ID in env/.env.playground is empty"
}

Write-Host "Running a365 develop add-permissions for app id $appId"
& a365 develop add-permissions --app-id $appId
if ($LASTEXITCODE -ne 0) {
    throw "a365 develop add-permissions failed"
}

Write-Host "Getting bearer token via a365..."
Write-Host "This may complete silently using cached credentials, or it may require interactive Windows sign-in (WAM)."
Write-Host "If interactive sign-in is required and no prompt appears, check the taskbar for a hidden sign-in window and bring it to front."
Write-Host "Running a365 develop get-token for app id $appId"
$tokenOutput = & a365 develop get-token --app-id $appId --output raw
if ($LASTEXITCODE -ne 0) {
    throw "a365 develop get-token failed"
}

$rawOutput = [string]::Join("`n", $tokenOutput)
$rawOutput = $rawOutput -replace "`r", ''

$bearerToken = $null
$jwtRegex = '(?<token>[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)'
$jwtMatches = [regex]::Matches($rawOutput, $jwtRegex)
if ($jwtMatches.Count -gt 0) {
    $bearerToken = ($jwtMatches | ForEach-Object { $_.Groups['token'].Value } | Sort-Object Length -Descending | Select-Object -First 1).Trim()
}

if ([string]::IsNullOrWhiteSpace($bearerToken)) {
    throw "Unable to extract a bearer token from a365 develop get-token output"
}

$userEnvLines = @()
if (Test-Path $playgroundUserEnvPath) {
    $userEnvLines = Get-Content $playgroundUserEnvPath
}

$updated = $false
for ($i = 0; $i -lt $userEnvLines.Count; $i++) {
    if ($userEnvLines[$i] -match '^\s*SECRET_BEARER_TOKEN\s*=') {
        $userEnvLines[$i] = "SECRET_BEARER_TOKEN=$bearerToken"
        $updated = $true
        break
    }
}

if (-not $updated) {
    if ($userEnvLines.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($userEnvLines[$userEnvLines.Count - 1])) {
        $userEnvLines += ''
    }
    $userEnvLines += "SECRET_BEARER_TOKEN=$bearerToken"
}

Set-Content -Path $playgroundUserEnvPath -Value $userEnvLines -Encoding UTF8
Write-Host 'SECRET_BEARER_TOKEN has been updated in env/.env.playground.user'
