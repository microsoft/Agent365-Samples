param(
    [Parameter(Mandatory=$false)]
    [string]$ConfigFile
)

function Get-AgentBlueprintTokenForGraph {
    param(
        [Parameter(Mandatory=$true)]
        [string]$TenantId,
        
        [Parameter(Mandatory=$true)]
        [string]$AgentBlueprintId,
        
        [Parameter(Mandatory=$false)]
        [string]$MsiToken,
        
        [Parameter(Mandatory=$false)]
        [string]$ClientSecret
    )
    
    $tokenEndpoint = "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token"
    
    $body = @{
        'client_id' = $AgentBlueprintId
        'scope' = '00000003-0000-0000-c000-000000000000/.default'
        'grant_type' = 'client_credentials'
    }
    
    # Use MSI token if provided, otherwise use client secret - we are using client secret for now
    if ($MsiToken) {
        $body['client_assertion_type'] = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
        $body['client_assertion'] = $MsiToken
    }
    elseif ($ClientSecret) {
        $body['client_secret'] = $ClientSecret
    }
    else {
        throw "Either MsiToken or ClientSecret must be provided"
    }
    
    $headers = @{
        'Content-Type' = 'application/x-www-form-urlencoded'
    }
    
    $response = Invoke-RestMethod -Uri $tokenEndpoint -Method POST -Body $body -Headers $headers
    return $response
}

function New-AgentIdentity {
    param(
        [Parameter(Mandatory=$true)]
        [string]$AccessToken,
        
        [Parameter(Mandatory=$true)]
        [string]$DisplayName,
        
        [Parameter(Mandatory=$true)]
        [string]$AgentBlueprintId
    )
    
    $currentUser = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/me"
        
    $uri = "https://graph.microsoft.com/beta/serviceprincipals/Microsoft.Graph.AgentIdentity"
        
    $headers = @{
            'OData-Version' = '4.0'
            'Content-Type' = 'application/json'
            'Authorization' = "Bearer $AccessToken"
        }

    try {
        $body = @{
            'displayName' = $DisplayName
            'agentAppId' = $AgentBlueprintId
            "sponsors@odata.bind" = @("https://graph.microsoft.com/v1.0/users/$($currentUser.Id)")
        } | ConvertTo-Json
        
        $response = Invoke-RestMethod -Uri $uri -Method POST -Headers $headers -Body $body
    }
    catch {
        
        if ($_.Exception.Response.StatusCode.value__ -eq 400)
        {
            Write-Host "Agent Blueprint creation failed with Bad Request (400). Fallback to call without sponsor request..."

            $body = @{
            'displayName' = $DisplayName
            'agentAppId' = $AgentBlueprintId
            } | ConvertTo-Json

            $fallbackResponse = Invoke-RestMethod -Uri $uri -Method POST -Headers $headers -Body $body

            return $fallbackResponse
        }
    }
    return $response
}

function New-AgentUser {
    param(
        [Parameter(Mandatory=$true)]
        [string]$DisplayName,
        
        [Parameter(Mandatory=$true)]
        [string]$UserPrincipalName,
        
        [Parameter(Mandatory=$true)]
        [string]$MailNickname,
        
        [Parameter(Mandatory=$true)]
        [string]$AgentIdentityId,
        
        [Parameter(Mandatory=$false)]
        [bool]$AccountEnabled = $true,

        [Parameter(Mandatory=$false)]
        [string]$UsageLocation = 'US'
    )
    
    # Connect to Graph with beta profile
    Connect-MgGraph -Scopes "User.ReadWrite.All" -TenantId $TenantId

    # Define request body
    $body = @{
        "@odata.type"       = "microsoft.graph.agentUser"
        displayName         = $DisplayName
        userPrincipalName   = $UserPrincipalName
        mailNickname        = $MailNickname
        accountEnabled      = $AccountEnabled
        usageLocation       = $UsageLocation
        identityParent      = @{
                                  id = $AgentIdentityId
                               }
    } | ConvertTo-Json -Depth 5

    
    # Check if user already exists
    try {
        $existingUser = Get-AzADUser -ObjectId $UserPrincipalName -ErrorAction Stop
        Write-Host "User already exists: $($existingUser.DisplayName) ($($existingUser.UserPrincipalName))." -ForegroundColor Yellow
        Write-Host "Using existing user instead of creating new one." -ForegroundColor Green
        
        # Create a response object that matches the expected format
        $response = @{
            id = $existingUser.Id
            displayName = $existingUser.DisplayName
            userPrincipalName = $existingUser.UserPrincipalName
            usageLocation = $existingUser.UsageLocation
        }
        return $response
    }
    catch {
       # User does not exist, proceed with creation
    }

    $response = Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/beta/users" -Body $body -ContentType "application/json"
    return $response
}

function Set-AgentUserManager {
    param(
        [Parameter(Mandatory=$true)]
        [string]$UserId,
        
        [Parameter(Mandatory=$true)]
        [string]$ManagerEmail
    )
    
    try {
        Write-Host "   Looking up manager with email: $ManagerEmail" -ForegroundColor Gray
        $manager = Get-MgUser -Filter "mail eq '$ManagerEmail'" -ErrorAction Stop
        if ($manager) {
            $managerId = $manager.Id
            Write-Host "   Found manager: $($manager.DisplayName) (ID: $managerId)" -ForegroundColor Gray
            
            $body = @{
                "@odata.id" = "https://graph.microsoft.com/v1.0/users/$managerId"
            } | ConvertTo-Json
            
            Invoke-MgGraphRequest -Method PUT -Uri "https://graph.microsoft.com/v1.0/users/$UserId/manager/`$ref" -Body $body -ContentType "application/json"
            
            return $manager
        } else {
            Write-Host "WARNING: Manager with email '$ManagerEmail' not found. Skipping manager assignment." -ForegroundColor Yellow
            return $null
        }
    }
    catch {
        Write-Host "ERROR: Failed to assign manager." -ForegroundColor Red
        Write-Host "   Details: $($_.Exception.Message)" -ForegroundColor Gray
        # Don't exit, just warn.
    }
}

# Display script header
Write-Host ""
Write-Host "================================================================================================" -ForegroundColor Cyan
Write-Host "                               Agent User Creation Script                                       " -ForegroundColor Cyan
Write-Host "================================================================================================" -ForegroundColor Cyan
Write-Host ""


# Check for configuration file parameter
if ($ConfigFile -and (Test-Path $ConfigFile)) {
    Write-Host "Reading configuration from file: $ConfigFile" -ForegroundColor Blue
    Write-Host ""
    
    try {
        $config = Get-Content $ConfigFile | ConvertFrom-Json
        
        $TenantId = $config.TenantId
        $AgentBlueprintId = $config.AgentBlueprintId
        $ClientSecret = $config.AgentBlueprintClientSecret
        $agentIdentityName = $config.AgentIdentityDisplayName
        $agentUserDisplayName = $config.AgentUserDisplayName
        $userPrincipalName = $config.AgentUserPrincipalName
        $mailNickname = $userPrincipalName.split('@')[0]
        $managerEmail = $config.ManagerEmail
        $usageLocation = $config.UsageLocation
        $existingAgentIdentityId = $config.AgentIdentityId
        $existingAgentUserId = $config.AgentUserId
        
        Write-Host "Configuration loaded successfully!" -ForegroundColor Green
        Write-Host "  • Tenant ID: $TenantId" -ForegroundColor Gray
        Write-Host "  • Agent Blueprint ID: $AgentBlueprintId" -ForegroundColor Gray
        Write-Host "  • Agent Identity Display Name: $agentIdentityName" -ForegroundColor Gray
        Write-Host "  • Agent User Display Name: $agentUserDisplayName" -ForegroundColor Gray
        Write-Host "  • Agent User Principal Name: $userPrincipalName" -ForegroundColor Gray
        Write-Host "  • Agent User Mail Nickname: $mailNickname" -ForegroundColor Gray
        if ($managerEmail) {
            Write-Host "  • Manager Email: $managerEmail" -ForegroundColor Gray
        }
        if ($usageLocation) {
            Write-Host "  • Usage Location: $usageLocation" -ForegroundColor Gray
        }
    }
    catch {
        Write-Host "ERROR: Failed to read configuration file" -ForegroundColor Red
        Write-Host "   Details: $($_.Exception.Message)" -ForegroundColor Gray
        exit 1
    }
}
else {
    # Interactive mode - prompt for configuration
    Write-Host "Configuration:" -ForegroundColor Blue
    Write-Host "  • Tenant ID: " -ForegroundColor Gray -NoNewline
    $TenantId = Read-Host
    Write-Host $TenantId -ForegroundColor White

    Write-Host "  • Agent Blueprint ID: " -ForegroundColor Gray -NoNewline
    $AgentBlueprintId = Read-Host
    Write-Host $AgentBlueprintId -ForegroundColor White

    Write-Host "  • Agent Blueprint Client Secret: " -ForegroundColor Gray -NoNewline
    $ClientSecret = Read-Host
  
}

Write-Host ""
Write-Host "Starting Agent User creation process..." -ForegroundColor Blue
Write-Host "------------------------------------------------------------------------------------------------" -ForegroundColor Gray

try {
    Connect-MgGraph -TenantId $TenantId
} catch {
    Write-Host "ERROR: Failed to connect to Microsoft Graph. Please ensure you have the Microsoft Graph PowerShell SDK installed and try again." -ForegroundColor Red
exit 1
}

# 1. Get Agent Blueprint token
Write-Host ""
Write-Host "Step 1/4: Getting Agent Blueprint token..." -ForegroundColor Yellow
try {

    $agentBlueprintGraphToken = Get-AgentBlueprintTokenForGraph -TenantId $TenantId -AgentBlueprintId $AgentBlueprintId -ClientSecret $ClientSecret
    Write-Host "Token retrieved successfully!" -ForegroundColor Green
    Write-Host "   Token Type: $($agentBlueprintGraphToken.token_type)" -ForegroundColor Cyan
    $expiresInMinutes = [math]::Round($agentBlueprintGraphToken.expires_in / 60, 1)
    Write-Host "   Expires In: $expiresInMinutes minutes" -ForegroundColor Cyan

} catch {
    Write-Host "ERROR: Failed to get Agent Blueprint token" -ForegroundColor Red
    Write-Host "   Details: $($_.Exception.Message)" -ForegroundColor Gray
    exit 1
}


# 2. Create Agent Identity (or reuse existing)
Write-Host ""
Write-Host "Step 2/4: Creating Agent Identity..." -ForegroundColor Yellow

# Check if agent identity already exists (idempotent)
if ($existingAgentIdentityId) {
    Write-Host "Checking for existing agent identity with ID: $existingAgentIdentityId" -ForegroundColor Gray
    try {
        $uri = "https://graph.microsoft.com/beta/servicePrincipals/$existingAgentIdentityId"
        $headers = @{ 'Authorization' = "Bearer $($agentBlueprintGraphToken.access_token)" }
        $existingIdentity = Invoke-RestMethod -Uri $uri -Method Get -Headers $headers -ErrorAction Stop
        
        Write-Host "Found existing agent identity!" -ForegroundColor Green
        Write-Host "   Agent Identity ID: $($existingIdentity.id)" -ForegroundColor Cyan
        Write-Host "   Display Name: $($existingIdentity.displayName)" -ForegroundColor Cyan
        $agentIdentity = $existingIdentity
    }
    catch {
        Write-Host "Existing identity not found (may have been deleted), creating new..." -ForegroundColor Yellow
        $existingAgentIdentityId = $null
    }
}

# Create new agent identity if none exists
if (-not $existingAgentIdentityId -or -not $agentIdentity) {
    if (-not $agentIdentityName) {
        Write-Host "Display Name for Agent Identity: " -ForegroundColor Yellow -NoNewline
        $agentIdentityName = Read-Host
    }

    try {
        $agentIdentity = New-AgentIdentity -AccessToken $agentBlueprintGraphToken.access_token -DisplayName $agentIdentityName -AgentBlueprintId $AgentBlueprintId
        Write-Host "Agent Identity created successfully!" -ForegroundColor Green
        Write-Host "   Agent Identity ID: $($agentIdentity.id)" -ForegroundColor Cyan
        Write-Host "   Display Name: $($agentIdentity.displayName)" -ForegroundColor Cyan
        
        Write-Host "Waiting 10 seconds to ensure Agent Identity is fully propagated..." -ForegroundColor Gray
        Start-Sleep -Seconds 10
    } catch {
        Write-Host "ERROR: Failed to create Agent Identity" -ForegroundColor Red
        Write-Host "   Details: $($_.Exception.Message)" -ForegroundColor Gray
        exit 1
    }
}


# 3. Create Agent User
Write-Host ""
Write-Host "Step 3/4: Creating Agent User..." -ForegroundColor Yellow
if (-not $agentUserDisplayName) {
    Write-Host "Agent User Display Name: " -ForegroundColor Yellow -NoNewline
    $agentUserDisplayName = Read-Host
}
if (-not $userPrincipalName) {
    Write-Host "Agent User Principal Name (e.g., <alias>@<verified tenant domain>): " -ForegroundColor Yellow -NoNewline
    $userPrincipalName = Read-Host
    $mailNickname = $userPrincipalName.split('@')[0]
}
$usageLocation = 'US'

try {
    $agentUser = New-AgentUser -DisplayName $agentUserDisplayName -UserPrincipalName $userPrincipalName -MailNickname $mailNickname -AgentIdentityId $agentIdentity.id -UsageLocation $usageLocation
    Write-Host "Agent User created successfully!" -ForegroundColor Green
    Write-Host "   Agent User ID: $($agentUser.id)" -ForegroundColor Cyan
    Write-Host "   Agent User Principal Name: $($agentUser.userPrincipalName)" -ForegroundColor Cyan
} catch {
    Write-Host "ERROR: Failed to create Agent User" -ForegroundColor Red
    Write-Host "$($_)"
    Write-Host "   Details: $($_.Exception.Message)" -ForegroundColor Gray
    
    # Don't exit - try to find existing user and continue with config update
    Write-Host "Attempting to find existing user..." -ForegroundColor Yellow
    try {
        $existingUser = Get-MgUser -Filter "userPrincipalName eq '$userPrincipalName'" -ErrorAction Stop
        if ($existingUser) {
            Write-Host "Found existing user!" -ForegroundColor Green
            Write-Host "   Agent User ID: $($existingUser.Id)" -ForegroundColor Cyan
            Write-Host "   Agent User Principal Name: $($existingUser.UserPrincipalName)" -ForegroundColor Cyan
            $agentUser = $existingUser
        }
    } catch {
        Write-Host "Could not find existing user: $($_.Exception.Message)" -ForegroundColor Yellow
        # Continue anyway to save at least the identity ID
        $agentUser = $null
    }
}

# 4. Assign Manager to Agent User
Write-Host ""
Write-Host "Step 4/4: Assigning Manager to Agent User..." -ForegroundColor Yellow
if (-not $managerEmail) {
    Write-Host "Manager's Email (optional, press Enter to skip): " -ForegroundColor Yellow -NoNewline
    $managerEmail = Read-Host
}

if ($managerEmail -and $agentUser -and $agentUser.id) {
    try {
        $assignedManager = Set-AgentUserManager -UserId $agentUser.id -ManagerEmail $managerEmail
        if ($assignedManager) {
            Write-Host "Manager assigned successfully!" -ForegroundColor Green
            Write-Host "   Manager Name: $($assignedManager.DisplayName)" -ForegroundColor Cyan
            Write-Host "   Manager Email: $($assignedManager.Mail)" -ForegroundColor Cyan
        }
    } catch {
        Write-Host "ERROR: Failed to assign manager" -ForegroundColor Red
        Write-Host "   Details: $($_.Exception.Message)" -ForegroundColor Gray
    }
} else {
    Write-Host "Skipping manager assignment." -ForegroundColor Gray
}


Write-Host ""
Write-Host "================================================================================================" -ForegroundColor Green
Write-Host "                                 AGENT USER CREATION COMPLETED!                                 " -ForegroundColor Green
Write-Host "================================================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Agent User Details:" -ForegroundColor Yellow
Write-Host "  • Agent Identity ID: $($agentIdentity.id)" -ForegroundColor White
Write-Host "  • Agent Identity Display Name: $($agentIdentity.displayName)" -ForegroundColor White
Write-Host "  • Agent User ID: $($agentUser.id)" -ForegroundColor White
Write-Host "  • Agent User Principal Name: $($agentUser.userPrincipalName)" -ForegroundColor White
Write-Host "  • Agent User Display Name: $($agentUser.displayName)" -ForegroundColor White
Write-Host "  • Agent User Usage Location: $($agentUser.usageLocation)" -ForegroundColor White
if ($assignedManager) {
    Write-Host "  • Assigned Manager: $($assignedManager.DisplayName) ($($assignedManager.Mail))" -ForegroundColor White
}
Write-Host ""

# Update the configuration file with the created IDs
if ($ConfigFile -and (Test-Path $ConfigFile)) {
    try {
        Write-Host "Updating configuration file with created IDs..." -ForegroundColor Blue
        $config = Get-Content $ConfigFile | ConvertFrom-Json
        
        # Always update identity ID (this should always be available)
        if ($agentIdentity -and $agentIdentity.id) {
            $config.AgentIdentityId = $agentIdentity.id
            Write-Host "   Updated AgentIdentityId: $($agentIdentity.id)" -ForegroundColor Green
        }
        
        # Update user ID only if user was created or found
        if ($agentUser -and $agentUser.id) {
            $config.AgentUserId = $agentUser.id
            $config.AgentUserPrincipalName = $agentUser.userPrincipalName
            Write-Host "   Updated AgentUserId: $($agentUser.id)" -ForegroundColor Green
        } else {
            Write-Host "   Skipped AgentUserId (user not available)" -ForegroundColor Yellow
        }
        
        $config | ConvertTo-Json -Depth 10 | Set-Content $ConfigFile -Encoding UTF8
        Write-Host "Configuration file updated successfully: $ConfigFile" -ForegroundColor Green
    }
    catch {
        Write-Host "WARNING: Failed to update configuration file: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}
else {
    Write-Host "No configuration file to update (running in interactive mode)" -ForegroundColor Gray
}
