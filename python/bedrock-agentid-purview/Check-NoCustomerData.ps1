<#
.SYNOPSIS
  Pre-PR check: fails if any customer- or tenant-specific value is still in the folder.

.DESCRIPTION
  Run from the folder you are about to commit. It scans every text file for:
    - the customer name and any extra words you pass in -Words
    - GUIDs (tenant id, Blueprint app id, Agent Identity id, label ids, site ids)
    - onmicrosoft.com / sharepoint.com host names
    - user principal names (anything@anything)
    - client secrets (lines that look like BLUEPRINT_CLIENT_SECRET=<value>)
  Documentation placeholders such as <TENANT_ID> or 00000003-0000-0000-c000-000000000000 (Microsoft Graph) are ignored.

.EXAMPLE
  .\Check-NoCustomerData.ps1 -Path . -Words "Contoso","FirstName","LastName"   # your customer name and demo-user names
#>
param(
    [string]   $Path  = ".",
    [string[]] $Words = @()
)
$allowedGuids = @("00000003-0000-0000-c000-000000000000", "e1fe6dd8-ba31-4d61-89e7-88639da4683d")  # Graph app id, Graph User.Read scope id
$patterns = @(
    @{ Name = "GUID";            Regex = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' },
    @{ Name = "Tenant host";     Regex = '[A-Za-z0-9-]+\.(onmicrosoft|sharepoint)\.com' },
    @{ Name = "UPN / e-mail";    Regex = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' },
    @{ Name = "Secret value";    Regex = '(?i)(client_secret|CLIENT_SECRET|secretText)\s*[=:]\s*[^\s<"]{8,}' }
)
foreach ($w in $Words) { $patterns += @{ Name = "Word '$w'"; Regex = "(?i)\b$([regex]::Escape($w))\b" } }

$files = Get-ChildItem -Path $Path -Recurse -File -Force |
         Where-Object { $_.FullName -notmatch '\\\.git\\|__pycache__|\.png$|\.jpg$|\.zip$|\.pyc$|\.docx$|\.xlsx$|\.mp4$' }
$hits = 0
foreach ($f in $files) {
    $n = 0
    foreach ($line in Get-Content -LiteralPath $f.FullName -ErrorAction SilentlyContinue) {
        $n++
        foreach ($p in $patterns) {
            foreach ($m in [regex]::Matches($line, $p.Regex)) {
                if ($p.Name -eq "GUID" -and $allowedGuids -contains $m.Value.ToLower()) { continue }
                if ($p.Name -eq "UPN / e-mail" -and $m.Value -match '(?i)@(contoso|example)\.') { continue }
                $hits++
                Write-Host ("{0}:{1}  [{2}]  {3}" -f $f.FullName.Replace((Resolve-Path $Path).Path, "."), $n, $p.Name, $line.Trim()) -ForegroundColor Yellow
            }
        }
    }
}
if ($hits -eq 0) { Write-Host "OK - no customer or tenant-specific values found." -ForegroundColor Green; exit 0 }
Write-Host "`n$hits finding(s). Replace each with a placeholder such as <TENANT_ID>, <demo user> or <tenant>.sharepoint.com before committing." -ForegroundColor Red
exit 1
