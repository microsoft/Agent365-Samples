# Get-AgenticUserToken.ps1
# Mirrors the 3-step flow in your C# code but uses a client secret read from file.
# Compatible with older PowerShell (no CmdletBinding, no Invoke-RestMethod).

param(
    [string]$TenantId,
    [string]$AgentAppInstanceId,  # Step 2 & 3 client_id; also used as user_federated_identity_credential audience
    [string]$AgentAppId,          # Step 1 client_id
    [string]$UserUpn,
    [string]$Scopes,              # GUID (resource) or scopes (space/comma separated)
    [string]$ClientSecretPath     # File containing ONLY the client secret VALUE
)

$ErrorActionPreference = 'Stop'

function Get-SecretFromFile {
    param([string]$Path)
    if (-not (Test-Path $Path)) {
        throw "Client secret file not found at '$Path'."
    }
    $secret = (Get-Content -Path $Path -Raw) 2>$null
    if (-not $secret) {
        # Fallback for very old PS without -Raw
        $secret = (Get-Content -Path $Path) -join "`n"
    }
    $secret = $secret.Trim()
    if (-not $secret) { throw "Client secret file '$Path' is empty." }
    $secret
}

function Normalize-Scopes {
    # Accepts: a GUID (resource app id) OR a list of scopes (space/comma separated)
    param([string]$Scopes)
    if (-not $Scopes) { throw "Scopes cannot be empty." }

    $parts = @()
    foreach ($p in ($Scopes -split '[\s,]+')) {
        if ($p -and $p.Trim().Length -gt 0) { $parts += $p.Trim() }
    }
    if ($parts.Count -eq 0) { throw "Invalid scopes input." }

    $guidRegex = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    $normalized = @()
    foreach ($p in $parts) {
        if ($p -match $guidRegex) {
            $normalized += ("{0}/.default" -f $p)
        } else {
            $normalized += $p
        }
    }
    ($normalized -join ' ')
}

function Invoke-FormPost {
    # Uses System.Net.WebClient for wide compatibility
    param(
        [string]$Url,
        [hashtable]$Body
    )

    $wc = New-Object System.Net.WebClient
    $wc.Headers['Content-Type'] = 'application/x-www-form-urlencoded'
    # Build form body manually for older PS/NET:
    $pairs = New-Object System.Collections.Generic.List[string]
    foreach ($k in $Body.Keys) {
        $key = [System.Uri]::EscapeDataString([string]$k)
        $val = [System.Uri]::EscapeDataString([string]$Body[$k])
        $pairs.Add("$key=$val")
    }
    $form = [string]::Join('&', $pairs.ToArray())

    try {
        $respBytes = $wc.UploadData($Url, 'POST', [System.Text.Encoding]::UTF8.GetBytes($form))
        $respText  = [System.Text.Encoding]::UTF8.GetString($respBytes)
        # parse JSON without ConvertFrom-Json (PS2 fallback)
        # Try ConvertFrom-Json if available; else use JavaScriptSerializer
        $jsonObj = $null
        $convFromJson = Get-Command ConvertFrom-Json -ErrorAction SilentlyContinue
        if ($convFromJson) {
            $jsonObj = $respText | ConvertFrom-Json
        } else {
            $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
            $jsonObj = $ser.DeserializeObject($respText)
        }
        if (-not $jsonObj -or -not $jsonObj.access_token) {
            throw ("No access_token in response. Raw: " + $respText)
        }
        return $jsonObj
    }
    catch [System.Net.WebException] {
        $errText = ""
        if ($_.Exception.Response -and $_.Exception.Response.GetResponseStream()) {
            $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
            $errText = $sr.ReadToEnd()
        }
        throw ("Token request failed. " + $errText)
    }
    finally {
        $wc.Dispose()
    }
}

# ----------------------------
# Main
# ----------------------------
if (-not $TenantId -or -not $AgentAppInstanceId -or -not $AgentAppId -or -not $UserUpn -or -not $Scopes -or -not $ClientSecretPath) {
    throw @"
Missing parameter(s).
Usage:
  .\Get-AgenticUserToken.ps1 `
    -TenantId ""<tenant-guid>"" `
    -AgentAppInstanceId ""<agent-app-instance-guid>"" `
    -AgentAppId ""<agent-app-guid>"" `
    -UserUpn ""<user@domain>"" `
    -Scopes ""<guid or scopes>"" `
    -ClientSecretPath "".\secret.txt""
"@
}

$clientSecret = Get-SecretFromFile -Path $ClientSecretPath
$tokenEndpoint = "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token"

# STEP 1: Token for AgentAppId using client_secret + fmi_path (matches C# semantics but with secret)
#   client_id     = AgentAppId
#   scope         = api://AzureAdTokenExchange/.default
#   grant_type    = client_credentials
#   fmi_path      = AgentAppInstanceId
#   client_secret = <from file>
$step1Body = @{
    client_id     = $AgentAppId
    scope         = 'api://AzureAdTokenExchange/.default'
    grant_type    = 'client_credentials'
    fmi_path      = $AgentAppInstanceId
    client_secret = $clientSecret
}
$step1 = Invoke-FormPost -Url $tokenEndpoint -Body $step1Body
$agentToken = $step1.access_token

# STEP 2: Token for AgentAppInstanceId using client_assertion = STEP 1 token
#   client_id             = AgentAppInstanceId
#   scope                 = api://AzureAdTokenExchange/.default
#   grant_type            = client_credentials
#   client_assertion_type = urn:ietf:params:oauth:client-assertion-type:jwt-bearer
#   client_assertion      = <STEP 1 access_token>
$step2Body = @{
    client_id             = $AgentAppInstanceId
    scope                 = 'api://AzureAdTokenExchange/.default'
    grant_type            = 'client_credentials'
    client_assertion_type = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
    client_assertion      = $agentToken
}
$step2 = Invoke-FormPost -Url $tokenEndpoint -Body $step2Body
$instanceToken = $step2.access_token

# STEP 3: User token (grant_type = user_fic)
#   client_id                          = AgentAppInstanceId
#   scope                              = (normalized)
#   client_assertion_type              = jwt-bearer
#   client_assertion                   = <STEP 1 access_token>
#   username                           = UserUpn
#   user_federated_identity_credential = <STEP 2 access_token>
#   grant_type                         = user_fic
$normalizedScopes = Normalize-Scopes -Scopes $Scopes
$step3Body = @{
    client_id                          = $AgentAppInstanceId
    scope                              = $normalizedScopes
    client_assertion_type              = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
    client_assertion                   = $agentToken
    username                           = $UserUpn
    user_federated_identity_credential = $instanceToken
    grant_type                         = 'user_fic'
}
$step3 = Invoke-FormPost -Url $tokenEndpoint -Body $step3Body
$finalToken = $step3.access_token

# Output ONLY the final token so it can be piped/assigned.
$finalToken
