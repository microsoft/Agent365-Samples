# Deploy the Google ADK A365 sample agent to GCP Cloud Run.
#
# Reads non-secret + secret env from the local .env (gitignored), applies the
# production overrides needed for the A365 observability exporter, and deploys
# via Cloud Run source buildpacks (Procfile -> `python main.py`).
#
# Cloud Run automatically injects PORT and K_SERVICE; main.py reads both, so the
# JWT middleware + production host binding engage with no extra config.
#
# Usage:
#   .\deploy-cloudrun.ps1 -ProjectId <gcp-project-id> [-Region us-central1] [-ServiceName gcp-a365-agent]

param(
    [Parameter(Mandatory = $true)] [string] $ProjectId,
    [string] $Region = "us-central1",
    [string] $ServiceName = "gcp-a365-agent"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) { throw ".env not found in $PSScriptRoot" }

# Production overrides applied on top of .env. PORT is intentionally omitted
# (Cloud Run sets it). AUTH_HANDLER_NAME=AGENTIC turns on agentic token exchange.
$overrides = [ordered]@{
    "AUTH_HANDLER_NAME"                    = "AGENTIC"
    "ENABLE_OBSERVABILITY"                 = "true"
    "ENABLE_A365_OBSERVABILITY_EXPORTER"   = "true"
    "PYTHON_ENVIRONMENT"                   = "production"
}

# Parse .env into an ordered map (skip comments, blanks, and PORT).
$envMap = [ordered]@{}
foreach ($line in Get-Content ".env") {
    $trimmed = $line.Trim()
    if ($trimmed -eq "" -or $trimmed.StartsWith("#")) { continue }
    $idx = $trimmed.IndexOf("=")
    if ($idx -lt 1) { continue }
    $key = $trimmed.Substring(0, $idx).Trim()
    $val = $trimmed.Substring($idx + 1).Trim()
    if ($key -eq "PORT") { continue }
    $envMap[$key] = $val
}
foreach ($k in $overrides.Keys) { $envMap[$k] = $overrides[$k] }

# Build the env-vars string using a custom delimiter (^##^) so values containing
# commas, slashes, colons, etc. are passed verbatim to gcloud.
$pairs = @()
foreach ($k in $envMap.Keys) { $pairs += "$k=$($envMap[$k])" }
$envArg = "^##^" + ($pairs -join "##")

Write-Host "Deploying '$ServiceName' to project '$ProjectId' ($Region) with $($envMap.Count) env vars..." -ForegroundColor Cyan

# --no-cpu-throttling (CPU always allocated) is REQUIRED: the OTel BatchSpanProcessor
# exports genAI spans on a background thread AFTER the turn returns. With default CPU
# throttling, that thread wakes on a frozen CPU and its TLS read stalls -> the gateway
# drops the connection (SSL UNEXPECTED_EOF_WHILE_READING) and spans are lost.
gcloud run deploy $ServiceName `
    --source . `
    --project $ProjectId `
    --region $Region `
    --platform managed `
    --allow-unauthenticated `
    --no-cpu-throttling `
    --set-env-vars $envArg

if ($LASTEXITCODE -ne 0) { throw "gcloud run deploy failed (exit $LASTEXITCODE)" }

$url = gcloud run services describe $ServiceName --project $ProjectId --region $Region --format "value(status.url)"
Write-Host ""
Write-Host "Deployed. Service URL: $url" -ForegroundColor Green
Write-Host "Messaging endpoint:    $url/api/messages" -ForegroundColor Green
Write-Host ""
Write-Host "Next: set messagingEndpoint in a365.config.json to the above, then run 'a365 setup all'." -ForegroundColor Yellow
