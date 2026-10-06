<#
.SYNOPSIS
  Step 2 of the Purview demo setup: create the DLP policy that protects the agent.

.DESCRIPTION
  The Purview portal cannot (yet) scope a DLP policy to an Entra-registered app, so this is
  done in Security & Compliance PowerShell. The policy:
    - Location  : the Agent Identity AND the Blueprint app (Application enforcement plane)
    - Rule      : block UploadText (the user's prompt) when the text contains a credit card
                  number or a U.S. SSN at LOW confidence; raise an alert + incident report.
                  Validated settings: the default confidence (High / Medium) never matches a bare
                  number in a chat prompt; a DownloadText restriction is rejected for Application
                  locations (responses are still evaluated and recorded); -StopPolicyProcessing is
                  not allowed for this location type.
  Optionally it also turns on the DSPM for AI "Know Your Data" collection policy so that the
  agent's interactions show up in DSPM for AI -> Activity explorer.

  Based on microsoft/purview-api-samples: AWSBedrock/create_purview_dlp_policy_customer_sample.ps1

.PREREQUISITES
  - PowerShell 7+, module ExchangeOnlineManagement (Install-Module ExchangeOnlineManagement)
  - A Purview role that can manage DLP: Compliance Administrator / Compliance Data Administrator
  - Microsoft Purview Audit enabled in the tenant

.EXAMPLE
  .\2-Create-PurviewDlpPolicy.ps1 -AgentIdentityId <agent-app-id> -BlueprintAppId <blueprint-app-id> -AlertRecipient admin@contoso.com
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $AgentIdentityId,          # AGENT_CLIENT_ID  (PURVIEW_LOCATION_APP_ID default)
    [Parameter(Mandatory)] [string] $BlueprintAppId,           # BLUEPRINT_APP_ID
    [string] $AgentDisplayName  = "Agent ID Weather Agent (Bedrock)",
    [string] $BlueprintName     = "Agent ID Blueprint",
    [string] $PolicyName        = "Agent ID Demo - Block sensitive data in AI agent",
    [string] $RuleName          = "Agent - Block sensitive info (Low confidence)",
    [string[]] $AlertRecipient  = @("SiteAdmin"),              # or explicit UPNs
    [ValidateSet("Enable","TestWithNotifications","TestWithoutNotifications")] [string] $Mode = "Enable",
    [switch] $EnableDspmCollectionPolicy,                      # also turn on DSPM for AI KYD collection
    [string] $DspmScopeGroupId                                 # Entra group (object id) containing the demo user(s)
)

$ErrorActionPreference = "Stop"

Write-Host "`n== Connecting to Security & Compliance PowerShell ==" -ForegroundColor Cyan
Connect-IPPSSession

# ---- Locations: both IDs, so the policy matches whichever app id Purview keys on -------------
$Locations = @(
    @{ Workload = "Applications"; Location = $AgentIdentityId; LocationDisplayName = $AgentDisplayName
       LocationSource = "Entra"; LocationType = "Individual"; Inclusions = @(@{ Type = "Tenant"; Identity = "All" }) },
    @{ Workload = "Applications"; Location = $BlueprintAppId;  LocationDisplayName = $BlueprintName
       LocationSource = "Entra"; LocationType = "Individual"; Inclusions = @(@{ Type = "Tenant"; Identity = "All" }) }
)
$LocationsJson = $Locations | ConvertTo-Json -Depth 6 -Compress

# ---- Policy ---------------------------------------------------------------------------------
Write-Host "`n== DLP policy: $PolicyName ==" -ForegroundColor Cyan
if (-not (Get-DlpCompliancePolicy -Identity $PolicyName -ErrorAction SilentlyContinue)) {
    New-DlpCompliancePolicy -Name $PolicyName -Comment "POC: Purview DLP for an Entra Agent ID agent running on AWS Bedrock" `
        -Locations $LocationsJson -EnforcementPlanes @("Application") -Mode $Mode | Out-Null
    Write-Host "  created" -ForegroundColor Green
} else {
    Set-DlpCompliancePolicy -Identity $PolicyName -Locations $LocationsJson -EnforcementPlanes @("Application") -Mode $Mode | Out-Null
    Write-Host "  updated" -ForegroundColor Yellow
}

# ---- Rule -----------------------------------------------------------------------------------
Write-Host "`n== DLP rule: $RuleName ==" -ForegroundColor Cyan
$RuleParams = @{
    ContentContainsSensitiveInformation = @(
        @{ Name = "Credit Card Number";                 minCount = "1"; confidencelevel = "Low" },
        @{ Name = "U.S. Social Security Number (SSN)";  minCount = "1"; confidencelevel = "Low" }
    )
    # UploadText only: DownloadText is not supported for Application-location policies
    # (the response is still evaluated and recorded through processContent).
    RestrictAccess         = @(
        @{ Setting = "UploadText";   Value = "Block" }    # user prompt -> agent
    )
    GenerateAlert          = $AlertRecipient
    GenerateIncidentReport = $AlertRecipient
    IncidentReportContent  = @("Default", "Detections", "DetectionDetails", "MatchedItem", "RulesMatched", "Service", "Severity", "Title")
    NotifyUser             = $AlertRecipient
    ReportSeverityLevel    = "High"
    Comment                = "Blocks prompts with credit card numbers or SSNs (low confidence) for the Agent ID demo agent."
}
if (-not (Get-DlpComplianceRule -Identity $RuleName -ErrorAction SilentlyContinue)) {
    New-DlpComplianceRule -Name $RuleName -Policy $PolicyName @RuleParams | Out-Null
    Write-Host "  created" -ForegroundColor Green
} else {
    Set-DlpComplianceRule -Identity $RuleName @RuleParams | Out-Null
    Write-Host "  updated" -ForegroundColor Yellow
}

# ---- Optional: DSPM for AI collection policy (interactions visible in Activity explorer) -------
if ($EnableDspmCollectionPolicy) {
    if (-not $DspmScopeGroupId) { throw "-EnableDspmCollectionPolicy requires -DspmScopeGroupId (an Entra group containing the demo user)" }
    Write-Host "`n== DSPM for AI collection policy (Know Your Data) ==" -ForegroundColor Cyan
    $KydName = "DSPM for AI - Collection policy for enterprise AI apps"
    # Same shape as microsoft/purview-api-samples create_purview_dlp_policy_customer_sample.ps1
    $KydScenario = '{"Activities":["UploadText","DownloadText"],"EnforcementPlanes":["Application"],"SensitiveTypeIds":["All"],"IsIngestionEnabled":true}'
    $KydLocations = '[{"Workload":"Applications","Location":"' + $DspmScopeGroupId + '","LocationSource":"Entra","LocationType":"Group","Inclusions":[{"Type":"Tenant","Identity":"All"}]}]'
    try {
        New-FeatureConfiguration -FeatureScenario KnowYourData -Name $KydName -Mode Enable -ScenarioConfig $KydScenario -Locations $KydLocations | Out-Null
        Write-Host "  created" -ForegroundColor Green
    } catch {
        Set-FeatureConfiguration -Identity $KydName -ScenarioConfig $KydScenario | Out-Null
        Write-Host "  updated (already existed)" -ForegroundColor Yellow
    }
}

Write-Host "`n== Verification ==" -ForegroundColor Cyan
Get-DlpCompliancePolicy -Identity $PolicyName | Format-List Name, Mode, Locations, EnforcementPlanes
Get-DlpComplianceRule  -Identity $RuleName   | Format-List Name, Policy, RestrictAccess, ReportSeverityLevel
Get-DlpCompliancePolicy -Identity $PolicyName | Format-List Name, Mode, DistributionStatus
Write-Host "Wait until DistributionStatus is no longer Pending and the portal shows Sync completed (up to ~1 hour), then test with: Charge credit card 4111 1111 1111 1111 for the Dallas trip" -ForegroundColor Yellow
