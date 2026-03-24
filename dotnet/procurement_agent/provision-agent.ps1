# PowerShell script to provision a agent locally
# This script calls the Provision API endpoint to create a new agent

param(
    [Parameter(Mandatory=$true)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$TenantId,
    
    [Parameter(Mandatory=$true)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$AgentBlueprintId,
    
    [Parameter(Mandatory=$true)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$AgentId,

    [Parameter(Mandatory=$true)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$UserObjectId,

    [Parameter(Mandatory=$true)]
    [string]$UserEmail,

    [Parameter(Mandatory=$false)]
    [string]$BaseUrl = "http://localhost:5280"
)

# API endpoint
$apiUrl = "$BaseUrl/api/agents/provision"

# Request body
$requestBody = @{
    TenantId = $TenantId
    AgentBlueprintId = $AgentBlueprintId
    AgentId = $AgentId
    UserObjectId = $UserObjectId
    UserEmail = $UserEmail
} | ConvertTo-Json

# Headers
$headers = @{
    "Content-Type" = "application/json"
}

Write-Host "Provisioning agent..." -ForegroundColor Green
Write-Host "API URL: $apiUrl" -ForegroundColor Cyan
Write-Host "Request Body: $requestBody" -ForegroundColor Yellow

try {
    # Make the API call
    $response = Invoke-RestMethod -Uri $apiUrl -Method POST -Body $requestBody -Headers $headers
    
    Write-Host "✅ Success!" -ForegroundColor Green
    Write-Host "Response: $response" -ForegroundColor White
}
catch {
    Write-Host "❌ Error occurred:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    
    if ($_.Exception.Response) {
        $statusCode = $_.Exception.Response.StatusCode
        Write-Host "Status Code: $statusCode" -ForegroundColor Red
        
        try {
            $errorResponse = $_.Exception.Response.GetResponseStream()
            $reader = New-Object System.IO.StreamReader($errorResponse)
            $errorContent = $reader.ReadToEnd()
            Write-Host "Error Response: $errorContent" -ForegroundColor Red
        }
        catch {
            Write-Host "Could not read error response" -ForegroundColor Red
        }
    }
}

Write-Host "`nExample usage:" -ForegroundColor Cyan
Write-Host ".\provision-agent.ps1" -ForegroundColor White
Write-Host ".\provision-agent.ps1 -TenantId $TenantId -AgentId $AgentId -UserObjectId $UserObjectId -UserEmail $UserEmail" -ForegroundColor White
