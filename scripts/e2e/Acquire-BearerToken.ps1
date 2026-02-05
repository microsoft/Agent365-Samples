# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    Acquires a bearer token using Resource Owner Password Credentials (ROPC) flow.

.DESCRIPTION
    MCP servers only support delegated (user) permissions, not application permissions.
    This script uses ROPC flow with a test service account to acquire user-delegated 
    tokens in the CI/CD pipeline.

.PARAMETER ClientId
    The application (client) ID with MCP permissions.

.PARAMETER TenantId
    The Azure AD tenant ID.

.PARAMETER Username
    The test service account UPN (should be excluded from MFA).

.PARAMETER Password
    The test service account password.

.PARAMETER Scope
    The scope to request. Defaults to MCP scope.

.OUTPUTS
    Returns the access token as a string.

.EXAMPLE
    $token = ./Acquire-BearerToken.ps1 -ClientId $clientId -TenantId $tenantId -Username $user -Password $pass
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$ClientId,
    
    [Parameter(Mandatory = $true)]
    [string]$TenantId,
    
    [Parameter(Mandatory = $true)]
    [string]$Username,
    
    [Parameter(Mandatory = $true)]
    [string]$Password,
    
    [Parameter(Mandatory = $false)]
    [string]$Scope = "ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/.default"
)

$ErrorActionPreference = "Stop"

Write-Host "Acquiring bearer token for MCP servers using ROPC flow..." -ForegroundColor Cyan
Write-Host "MCP servers require delegated (user) tokens, not service principal tokens" -ForegroundColor Gray

$body = @{
    grant_type = "password"
    client_id  = $ClientId
    scope      = $Scope
    username   = $Username
    password   = $Password
}

$tokenEndpoint = "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token"

try {
    $response = Invoke-RestMethod -Uri $tokenEndpoint -Method POST -Body $body -ContentType "application/x-www-form-urlencoded"
    $token = $response.access_token
    
    if ([string]::IsNullOrEmpty($token)) {
        throw "Token response did not contain access_token"
    }
    
    $tokenLength = $token.Length
    $expiresIn = $response.expires_in
    Write-Host "Bearer token acquired successfully" -ForegroundColor Green
    Write-Host "  Token length: $tokenLength characters" -ForegroundColor Gray
    Write-Host "  Expires in: $expiresIn seconds" -ForegroundColor Gray
    
    # Return the token
    return $token
}
catch {
    Write-Error "Failed to acquire bearer token via ROPC: $_"
    Write-Host "Ensure the following variables are set:" -ForegroundColor Yellow
    Write-Host "  - ClientId: App registration with MCP permissions" -ForegroundColor Yellow
    Write-Host "  - TenantId: Azure AD tenant ID" -ForegroundColor Yellow
    Write-Host "  - Username: Service account UPN (excluded from MFA)" -ForegroundColor Yellow
    Write-Host "  - Password: Service account password" -ForegroundColor Yellow
    throw
}
