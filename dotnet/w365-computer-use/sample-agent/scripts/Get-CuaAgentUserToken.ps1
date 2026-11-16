# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
Acquires a CUA user access token for an agent using the Entra user_fic flow.

.DESCRIPTION
Requests an application token, exchanges it for an agent identity token, and then
requests a CUA user token from Microsoft Entra ID. By default, the script assigns
the final CUA access token to $env:BEARER_TOKEN in the current PowerShell
process. Use -ShowOid
to decode the final token payload and write the oid claim to the information
stream.

.EXAMPLE
.\Get-CuaAgentUserToken.ps1 -TenantId "contoso.onmicrosoft.com" -AgentBlueprintClientId "00000000-0000-0000-0000-000000000000" -AgentBlueprintClientSecret "<agent-blueprint-client-secret>" -AgentClientId "11111111-1111-1111-1111-111111111111" -AgentUsername "user@contoso.com"

Assigns the final CUA access token to $env:BEARER_TOKEN in the current
PowerShell process.

.EXAMPLE
.\Get-CuaAgentUserToken.ps1 -TenantId "contoso.onmicrosoft.com" -AgentBlueprintClientId "00000000-0000-0000-0000-000000000000" -AgentBlueprintClientSecret "<agent-blueprint-client-secret>" -AgentClientId "11111111-1111-1111-1111-111111111111" -AgentUsername "user@contoso.com" -SetBearerToken -InformationAction Continue

Assigns the final CUA access token to $env:BEARER_TOKEN in the current
PowerShell process.

.EXAMPLE
.\Get-CuaAgentUserToken.ps1 -TenantId "contoso.onmicrosoft.com" -AgentBlueprintClientId "00000000-0000-0000-0000-000000000000" -AgentBlueprintClientSecret "<agent-blueprint-client-secret>" -AgentClientId "11111111-1111-1111-1111-111111111111" -AgentUsername "user@contoso.com" -ShowOid -InformationAction Continue

Assigns the final CUA access token to $env:BEARER_TOKEN and writes the token
oid claim to the information stream.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TenantId,
    [Parameter(Mandatory = $true)]
    [string]$AgentBlueprintClientId,
    [Parameter(Mandatory = $true)]
    [string]$AgentBlueprintClientSecret,
    [Parameter(Mandatory = $true)]
    [string]$AgentClientId,
    [Parameter(Mandatory = $true)]
    [string]$AgentUsername,
    [string]$AuthorityHost = "https://login.microsoftonline.com",
    [string]$Scope = "da81128c-e5b5-4f9e-8d89-50d906f107c5/.default",
    [switch]$SetBearerToken = $true,
    [switch]$ShowOid
)

$ErrorActionPreference = "Stop"

function Assert-RequiredParameter {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [AllowNull()]
        [string]$Value
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "Parameter validation failed: -$Name is required."
    }
}

function Get-AccessTokenFromResponse {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Response,

        [Parameter(Mandatory = $true)]
        [string]$StepLabel
    )

    if ($null -eq $Response -or [string]::IsNullOrWhiteSpace($Response.access_token)) {
        throw "$StepLabel failed: token response missing required field 'access_token'."
    }

    return $Response.access_token
}

function ConvertFrom-Base64Url {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    $base64 = $Value.Replace("-", "+").Replace("_", "/")
    $padding = (4 - ($base64.Length % 4)) % 4
    if ($padding -gt 0) {
        $base64 = $base64 + ("=" * $padding)
    }

    $bytes = [Convert]::FromBase64String($base64)
    return [System.Text.Encoding]::UTF8.GetString($bytes)
}

function Write-OidInformation {
    param(
        [Parameter(Mandatory = $true)]
        [string]$AccessToken
    )

    try {
        $segments = $AccessToken.Split(".")
        if ($segments.Count -ne 3) {
            Write-Warning "ShowOid decode failed: access token is not a valid JWT (expected 3 segments)."
            return
        }

        $payloadJson = ConvertFrom-Base64Url -Value $segments[1]
        $claims = $payloadJson | ConvertFrom-Json
        if ([string]::IsNullOrWhiteSpace($claims.oid)) {
            Write-Warning "ShowOid decode completed but JWT payload did not contain an 'oid' claim."
            return
        }

        Write-Information $claims.oid
    }
    catch {
        Write-Warning "ShowOid decode failed: $($_.Exception.Message)"
    }
}

Assert-RequiredParameter -Name "TenantId" -Value $TenantId
Assert-RequiredParameter -Name "AgentBlueprintClientId" -Value $AgentBlueprintClientId
Assert-RequiredParameter -Name "AgentBlueprintClientSecret" -Value $AgentBlueprintClientSecret
Assert-RequiredParameter -Name "AgentClientId" -Value $AgentClientId
Assert-RequiredParameter -Name "AgentUsername" -Value $AgentUsername
Assert-RequiredParameter -Name "AuthorityHost" -Value $AuthorityHost
Assert-RequiredParameter -Name "Scope" -Value $Scope

$tokenUrl = "$($AuthorityHost.TrimEnd('/'))/$TenantId/oauth2/v2.0/token"
$clientAssertionType = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"

try {
    $applicationTokenResponse = Invoke-RestMethod -Method Post -Uri $tokenUrl -ContentType "application/x-www-form-urlencoded" -Body @{
        client_id     = $AgentBlueprintClientId
        scope         = "api://AzureADTokenExchange/.default"
        grant_type    = "client_credentials"
        client_secret = $AgentBlueprintClientSecret
        fmi_path      = $AgentClientId
    }
    $applicationToken = Get-AccessTokenFromResponse -Response $applicationTokenResponse -StepLabel "Application token request"
}
catch {
    throw "Application token request failed: $($_.Exception.Message)"
}

try {
    $agentIdentityTokenResponse = Invoke-RestMethod -Method Post -Uri $tokenUrl -ContentType "application/x-www-form-urlencoded" -Body @{
        client_id             = $AgentClientId
        scope                 = "api://AzureADTokenExchange/.default"
        grant_type            = "client_credentials"
        client_assertion_type = $clientAssertionType
        client_assertion      = $applicationToken
    }
    $agentIdentityToken = Get-AccessTokenFromResponse -Response $agentIdentityTokenResponse -StepLabel "Agent identity token request"
}
catch {
    throw "Agent identity token request failed: $($_.Exception.Message)"
}

try {
    $cuaTokenResponse = Invoke-RestMethod -Method Post -Uri $tokenUrl -ContentType "application/x-www-form-urlencoded" -Body @{
        client_id                           = $AgentClientId
        scope                               = $Scope
        grant_type                          = "user_fic"
        client_assertion_type               = $clientAssertionType
        client_assertion                    = $applicationToken
        username                            = $AgentUsername
        user_federated_identity_credential  = $agentIdentityToken
    }
    $cuaAccessToken = Get-AccessTokenFromResponse -Response $cuaTokenResponse -StepLabel "CUA token request"
}
catch {
    throw "CUA token request failed: $($_.Exception.Message)"
}

if ($ShowOid) {
    Write-OidInformation -AccessToken $cuaAccessToken
}

if ($SetBearerToken) {
    $env:BEARER_TOKEN = $cuaAccessToken
    Write-Information "Set `$env:BEARER_TOKEN for the current PowerShell process."
}
else {
    Write-Information "Token acquired. `$env:BEARER_TOKEN was not set because -SetBearerToken was false."
}
