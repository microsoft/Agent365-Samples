# Verify UserState SharePoint list contents
# Usage: .\verify-userstate.ps1
# Requires: az login (uses your Azure CLI session to get a Graph token)

$ErrorActionPreference = 'Stop'

# --- Config (matches .env) ---
$siteHost = if ($env:SP_SITE_HOST) { $env:SP_SITE_HOST } else { 'contoso.sharepoint.com' }
$sitePath = if ($env:SP_SITE_PATH) { $env:SP_SITE_PATH.TrimStart('/') } else { 'sites/CareerCoach' }
$listName = 'UserState'

Write-Host "`n=== UserState Verification ===" -ForegroundColor Cyan

# --- Get a Graph token via Azure CLI ---
Write-Host "Acquiring Microsoft Graph token via az..." -ForegroundColor DarkGray
$token = (az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv)
if (-not $token) {
    Write-Host "Failed to get Graph token. Run 'az login' first." -ForegroundColor Red
    exit 1
}
$headers = @{ Authorization = "Bearer $token" }

# --- Resolve site ID ---
$siteResp = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/sites/${siteHost}:/${sitePath}" -Headers $headers
$siteId = $siteResp.id
Write-Host "Site ID: $siteId" -ForegroundColor DarkGray

# --- Resolve list ID ---
$listsResp = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/sites/$siteId/lists?`$filter=displayName eq '$listName'" -Headers $headers
$list = $listsResp.value | Select-Object -First 1
if (-not $list) {
    Write-Host "List '$listName' not found." -ForegroundColor Red
    exit 1
}
$listId = $list.id
Write-Host "List ID: $listId`n" -ForegroundColor DarkGray

# --- Fetch items with fields ---
$itemsResp = Invoke-RestMethod -Uri "https://graph.microsoft.com/v1.0/sites/$siteId/lists/$listId/items?`$expand=fields&`$top=50" -Headers $headers
$items = $itemsResp.value

if (-not $items -or $items.Count -eq 0) {
    Write-Host "No rows in UserState. (No user has created a plan yet.)" -ForegroundColor Yellow
    exit 0
}

Write-Host "Found $($items.Count) user row(s):`n" -ForegroundColor Green

foreach ($item in $items) {
    $f = $item.fields
    Write-Host "──────────────────────────────────────────────" -ForegroundColor DarkGray
    Write-Host "User:            $($f.Title)" -ForegroundColor White
    Write-Host "UserAADId:       $($f.UserAADId)"
    Write-Host "Current Role:    $($f.CurrentRole)"
    Write-Host "Target Role:     $($f.TargetRole) ($($f.TargetRoleId))"
    Write-Host "Overall Progress:$($f.OverallProgress)%"
    Write-Host "Plan Created:    $($f.PlanCreatedDate)   Last Check-in: $($f.LastCheckIn)"
    if ($f.ManagerAsks) { Write-Host "Manager Asks:    $($f.ManagerAsks)" }

    Write-Host "`n  GOALS:" -ForegroundColor Cyan
    try { ($f.Goals | ConvertFrom-Json) | ForEach-Object { Write-Host "    - [$($_.status)] $($_.competencyName) — $($_.progressPct)%" } }
    catch { Write-Host "    (raw) $($f.Goals)" -ForegroundColor DarkGray }

    Write-Host "`n  SKILLS:" -ForegroundColor Cyan
    try { ($f.Skills | ConvertFrom-Json) | ForEach-Object { Write-Host "    - $($_.competencyName): Lvl $($_.currentLevel)/$($_.targetLevel)  Gap $($_.gap)  [$($_.gapCategory)]" } }
    catch { Write-Host "    (raw) $($f.Skills)" -ForegroundColor DarkGray }

    Write-Host "`n  LEARNING PROGRESS:" -ForegroundColor Cyan
    try { ($f.LearningProgress | ConvertFrom-Json) | ForEach-Object { Write-Host "    - [$($_.status)] $($_.courseTitle) ($($_.courseId))" } }
    catch { Write-Host "    (raw) $($f.LearningProgress)" -ForegroundColor DarkGray }
    Write-Host ""
}
Write-Host "──────────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host "Done.`n" -ForegroundColor Green
