<#
.SYNOPSIS
Ensures an oauth2PermissionGrant exists for a given calling App (by App ID)
to Microsoft Graph (resource) with consentType AllPrincipals, and includes the scope
"AgentApplication.Create". If a grant exists, it will be updated to include the scope.
If it doesn't exist, it will be created.

.PARAMETER CallingAppId
The Application (client) ID of the calling app registration.

.EXAMPLE
.\Ensure-GraphGrant.ps1 -CallingAppId "11111111-2222-3333-4444-555555555555"
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory=$false)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$CallingAppId,
    [Parameter(Mandatory=$false)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$TenantId,
    [switch]$NonInteractive
)

# --- Configuration ---
$RequiredScopes = @('Application.ReadWrite.All','DelegatedPermissionGrant.ReadWrite.All')
$GraphAppId     = '00000003-0000-0000-c000-000000000000'   # Microsoft Graph
$TargetScope    = 'AgentApplication.Create Application.ReadWrite.All'
$AllPrincipalsConsentType    = 'AllPrincipals'

function Ensure-GraphSubModule {
    param([string]$Name)
    if (-not (Get-Module -ListAvailable -Name $Name)) {
        Write-Host "Installing module '$Name'..." -ForegroundColor Yellow
        Install-Module -Name $Name -Scope CurrentUser -Force -AllowClobber -ErrorAction Stop
    }
    if (-not (Get-Module -Name $Name)) {
        Write-Host "Importing module '$Name'..." -ForegroundColor Cyan
        Import-Module $Name -ErrorAction Stop
    }
}

function Initialize-SpecificGraphModules {
    $RequiredModules = @(
        'Microsoft.Graph.Authentication',
        'Microsoft.Graph.Applications', 
        'Microsoft.Graph.Identity.SignIns'
    )
    foreach ($m in $RequiredModules) { Ensure-GraphSubModule -Name $m }
}

function Connect-GraphIfNeeded {
    param([string[]]$Scopes,[string]$TenantId)
    if (-not (Get-MgContext)) {
        Write-Host "Connecting to Microsoft Graph for tenant '$TenantId'..." -ForegroundColor Cyan
        if ($TenantId) {
            Connect-MgGraph -Scopes $Scopes -TenantId $TenantId -ErrorAction Stop | Out-Null
        } else {
            Connect-MgGraph -Scopes $Scopes -ErrorAction Stop | Out-Null
        }
        $ctx = Get-MgContext
        Write-Host "Connected to tenant '$($ctx.TenantId)'. Account: $($ctx.Account)" -ForegroundColor Green
    } else {
        Write-Host "Microsoft Graph already connected (context reused)." -ForegroundColor DarkGray
    }
}

function Get-OrCreateServicePrincipalByAppId {
    param([string]$AppId)
    $sp = Get-MgServicePrincipal -Filter "appId eq '$AppId'" -ErrorAction Stop
    if ($sp) { return $sp } else { New-MgServicePrincipal -AppId $AppId -ErrorAction Stop }
}

function Get-GraphServicePrincipal { param([string]$AppId) Get-MgServicePrincipal -Filter "appId eq '$AppId'" -ErrorAction Stop }

function Get-ExistingAllPrincipalsGrant { param([string]$ClientId,[string]$ResourceId) Get-MgOauth2PermissionGrant -Filter "clientId eq '$ClientId' and resourceId eq '$ResourceId' and consentType eq '$AllPrincipalsConsentType'" }

function Ensure-ScopeOnGrant {
    param($Grant,[string]$ScopeToAdd)
    $existingScopes = @()
    if ($Grant.Scope) { $existingScopes = $Grant.Scope -split '\s+' | Where-Object { $_ } }
    if ($existingScopes -contains $ScopeToAdd) { return }
    $newScope = ($existingScopes + $ScopeToAdd | Sort-Object -Unique) -join ' '
    Update-MgOauth2PermissionGrant -OAuth2PermissionGrantId $Grant.Id -Scope $newScope -ErrorAction Stop | Out-Null
}

function Create-AllPrincipalsGrant { param([string]$ClientId,[string]$ResourceId,[string]$Scope) New-MgOauth2PermissionGrant -BodyParameter @{clientId=$ClientId;consentType=$AllPrincipalsConsentType;resourceId=$ResourceId;scope=$Scope} -ErrorAction Stop }

try {
    Initialize-SpecificGraphModules

    if (-not $TenantId) {
        if ($NonInteractive) { throw "TenantId parameter required in NonInteractive mode." }
        $TenantId = Read-Host "Enter your Tenant ID (GUID)"
    }
    if (-not ($TenantId -match '^[0-9a-fA-F-]{36}$')) { throw "Tenant ID '$TenantId' is not a valid GUID." }

    Connect-GraphIfNeeded -Scopes $RequiredScopes -TenantId $TenantId

    if (-not $CallingAppId) {
        if ($NonInteractive) { throw "CallingAppId parameter required in NonInteractive mode." }
        $CallingAppId = Read-Host "Enter the calling App ID (Application/Client ID)"
    }
    if (-not ($CallingAppId -match '^[0-9a-fA-F-]{36}$')) { throw "Calling App ID '$CallingAppId' is not a valid GUID." }

    $clientSp = Get-OrCreateServicePrincipalByAppId -AppId $CallingAppId
    $graphSp  = Get-GraphServicePrincipal -AppId $GraphAppId

    $existingGrants = Get-ExistingAllPrincipalsGrant -ClientId $clientSp.Id -ResourceId $graphSp.Id
    if ($existingGrants) {
        foreach ($grant in $existingGrants) { Ensure-ScopeOnGrant -Grant $grant -ScopeToAdd $TargetScope }
    } else { Create-AllPrincipalsGrant -ClientId $clientSp.Id -ResourceId $graphSp.Id -Scope $TargetScope | Out-Null }

    Write-Host "Grant ensured for scope '$TargetScope'." -ForegroundColor Green
}
catch { Write-Error $_; exit 1 }
