# bootstrap-graph-app.ps1
#
# Provisions the standalone Graph worker app for the Chief of Staff sample.
# Re-running is safe for permissions and consent: missing roles are added and
# verified. An existing, unexpired client secret is KEPT unless you pass
# -RotateSecret, in which case a new secret is APPENDED (old ones are never
# deleted by this script).
#
# Requires:
#   - az CLI installed; an admin account for the target tenant (interactive
#     login renewal is attempted once when its cached session has expired)
#   - PowerShell 7+
#
# What it does:
#   1. Finds (exact display-name match) or creates the Entra app registration
#      + service principal named "cos-graph-worker". Stops if the name is
#      ambiguous.
#   2. Adds the least-privilege Graph application permissions the sample uses.
#   3. Admin-consents them tenant-wide and verifies every role is assigned.
#   4. Creates a client secret only when needed (or with -RotateSecret) and
#      prints the values to paste into scenarios/chief-of-staff/.env.
#
# NOTE about OnlineMeeting-related Graph APIs:
# Application-permission calls to /users/{id}/onlineMeetings/*, /transcripts,
# and /aiInsights ADDITIONALLY require a Teams application-access policy
# granted to the target user(s). This script emits the Teams PowerShell
# commands you need to run once as tenant admin — see final output.

param(
  # Append a new client secret even if an unexpired one already exists.
  [switch]$RotateSecret,
  # Skips the tenant prompt when no cached account identifies the tenant.
  [string]$TenantId,
  [switch]$UseDeviceCode
)

$ErrorActionPreference = 'Stop'
# Make native az.exe failures terminate the script (PowerShell 7.3+).
$PSNativeCommandUseErrorActionPreference = $true

$APP_NAME  = 'cos-graph-worker'
$GRAPH_ID  = '00000003-0000-0000-c000-000000000000'

# Least-privilege application permissions used by the sample's code paths.
$APP_ROLE_NAMES = @(
  'Calendars.Read',                    # calendarView for meeting discovery + brief
  'OnlineMeetings.Read.All',           # joinWebUrl -> onlineMeeting id
  'OnlineMeetingTranscript.Read.All',  # transcripts + transcript content
  'OnlineMeetingAiInsight.Read.All',   # Copilot meeting insights
  'Tasks.ReadWrite.All',               # Planner read/write
  'User.Read.All',                     # user lookups / directory search
  'GroupMember.Read.All',              # leadership-team lookup + membership
  'ChatMember.Read.All'                # graph_list_meeting_attendees (meeting chat members)
)

function Invoke-Az {
  # Runs az with the given arguments and fails loudly on a non-zero exit.
  param([Parameter(Mandatory)][string[]]$Arguments)
  Get-Command az -ErrorAction Stop | Out-Null
  # Handle the exit ourselves so callers can add actionable recovery guidance.
  $PSNativeCommandUseErrorActionPreference = $false
  $ErrorActionPreference = 'Continue'
  $output = @(& az @Arguments 2>&1)
  $exitCode = $LASTEXITCODE
  $stderr = @($output | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] })
  foreach ($line in $stderr) { [Console]::Error.WriteLine($line.ToString()) }
  if ($exitCode -ne 0) {
    $failure = [System.InvalidOperationException]::new("az $($Arguments -join ' ') failed with exit code $exitCode")
    $errorText = $output -join "`n"
    $missingAccount = $Arguments[0] -eq 'account' -and $Arguments[1] -eq 'show' -and
      $errorText -match 'No subscriptions? found'
    $failure.Data['RequiresLogin'] = $missingAccount -or
      $errorText -match 'invalid_grant|AADSTS50173|AADSTS700082|AADSTS70043|InteractionRequired|Please run.*az login'
    throw $failure
  }
  return $output | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }
}

function Invoke-AzJson {
  param([Parameter(Mandatory)][string[]]$Arguments)
  $raw = Invoke-Az -Arguments ($Arguments + @('-o', 'json'))
  if (-not $raw) { return $null }
  return ($raw | Out-String | ConvertFrom-Json)
}

Write-Host '=== 0. Confirming az login ==='
$acct = $null
try {
  $expectedTenant = $TenantId
  for ($loginAttempt = 0; $loginAttempt -le 1; $loginAttempt++) {
    try {
      $acct = Invoke-AzJson @('account', 'show')
      if (-not $acct.tenantId) {
        $missingAccount = [System.InvalidOperationException]::new('Azure CLI has no selected account or tenant.')
        $missingAccount.Data['RequiresLogin'] = $true
        throw $missingAccount
      }
      if ($expectedTenant -and $acct.tenantId -ne $expectedTenant) {
        throw "Azure CLI selected a different tenant. Sign in to tenant '$expectedTenant' before provisioning."
      }
      # account show reads cached metadata, even when its refresh token is revoked.
      $appMatches = @(
        Invoke-AzJson @('ad', 'app', 'list', '--filter', "displayName eq '$APP_NAME'") |
          Where-Object { $_.displayName -eq $APP_NAME }
      )
      break
    } catch {
      $loginTenant = if ($expectedTenant) { $expectedTenant } else { $acct.tenantId }
      if (-not $_.Exception.Data['RequiresLogin'] -or $loginAttempt -gt 0) { throw }
      if (-not $loginTenant) {
        Write-Host 'No selected Azure CLI account identifies the target tenant.'
        $loginTenant = [string](Read-Host 'Enter the target tenant GUID (leave blank to cancel)')
        $parsedTenant = [guid]::Empty
        if (-not [guid]::TryParse($loginTenant.Trim(), [ref]$parsedTenant) -or $parsedTenant -eq [guid]::Empty) {
          throw 'A valid target tenant GUID is required for sign-in. No provisioning changes were made.'
        }
        $loginTenant = $parsedTenant.ToString()
      }
      $expectedTenant = $loginTenant
      Write-Host 'Azure CLI authentication needs renewal. Starting sign-in; complete the browser/device-code prompt and any MFA.'
      $loginArguments = @('login', '--tenant', $loginTenant, '--allow-no-subscriptions', '--scope', 'https://graph.microsoft.com/.default', '--output', 'none')
      if ($UseDeviceCode) { $loginArguments += '--use-device-code' }
      # Stream login prompts immediately instead of buffering them in Invoke-Az.
      $PSNativeCommandUseErrorActionPreference = $false
      & az @loginArguments | Out-Host
      if ($LASTEXITCODE -ne 0) { throw 'Azure CLI sign-in failed or was cancelled. No provisioning changes were made.' }
      Write-Host 'Sign-in completed. Retrying the live Graph check.'
    }
  }
} catch {
  $recoveryTenant = if ($expectedTenant) { $expectedTenant } else { $acct.tenantId }
  $tenantArgument = if ($recoveryTenant) { " --tenant `"$recoveryTenant`"" } else { ' --tenant "<target-tenant-id>"' }
  Write-Host ''
  Write-Host 'Could not verify live Microsoft Graph access. No app, permission, or secret was changed.'
  Write-Host 'If Azure CLI reports invalid_grant / AADSTS50173, its cached login was revoked.'
  Write-Host '"No subscription found" means no usable CLI account is selected; sign in with --allow-no-subscriptions.'
  Write-Host 'Sign in again as an administrator in the target tenant, then rerun this script:'
  Write-Host "  az login$tenantArgument --allow-no-subscriptions --scope `"https://graph.microsoft.com/.default`""
  Write-Host 'If browser sign-in is unavailable, add --use-device-code (if allowed by your tenant).'
  throw
}
Write-Host "  tenant: $($acct.tenantId)"
Write-Host "  user  : $($acct.user.name)"

Write-Host ''
Write-Host "=== 1. Ensuring app registration '$APP_NAME' exists ==="
# Exact matches were read during the live-login preflight above.
if ($appMatches.Count -gt 1) {
  throw "Refusing to continue: $($appMatches.Count) Entra apps are named '$APP_NAME'. Rename or delete the extras before admin-consent or credential changes."
}
$app = $appMatches | Select-Object -First 1
if (-not $app) {
  Write-Host '  creating app registration...'
  $app = Invoke-AzJson @('ad', 'app', 'create', '--display-name', $APP_NAME, '--sign-in-audience', 'AzureADMyOrg')
  Write-Host "  created '$($app.displayName)' appId=$($app.appId)"
} else {
  Write-Host "  found existing '$($app.displayName)' appId=$($app.appId)"
}
$APP_ID = $app.appId

Write-Host ''
Write-Host "=== 2. Ensuring service principal for '$APP_NAME' exists ==="
$sp = @(Invoke-AzJson @('ad', 'sp', 'list', '--filter', "appId eq '$APP_ID'")) | Select-Object -First 1
if (-not $sp) {
  Write-Host '  creating service principal...'
  # A brand-new app can take a few seconds to replicate.
  for ($attempt = 1; -not $sp; $attempt++) {
    try {
      $sp = Invoke-AzJson @('ad', 'sp', 'create', '--id', $APP_ID)
    } catch {
      if ($attempt -ge 6) { throw }
      Write-Host "  app not replicated yet — retrying in 10s ($attempt/6)"
      Start-Sleep -Seconds 10
    }
  }
  Write-Host "  created spObjectId=$($sp.id)"
} else {
  Write-Host "  found existing spObjectId=$($sp.id)"
}

Write-Host ''
Write-Host '=== 3. Adding missing Application permissions on Microsoft Graph ==='
$graphSp = Invoke-AzJson @('ad', 'sp', 'show', '--id', $GRAPH_ID)
$appDetails = Invoke-AzJson @('ad', 'app', 'show', '--id', $APP_ID)
$existingRoleIds = @(
  $appDetails.requiredResourceAccess |
    Where-Object { $_.resourceAppId -eq $GRAPH_ID } |
    ForEach-Object { $_.resourceAccess } |
    Where-Object { $_.type -eq 'Role' } |
    ForEach-Object { $_.id }
)
$wantedRoleIds = @{}
foreach ($roleName in $APP_ROLE_NAMES) {
  $role = $graphSp.appRoles | Where-Object { $_.value -eq $roleName }
  if (-not $role) { throw "appRole '$roleName' was not found on the Microsoft Graph service principal." }
  $wantedRoleIds[$roleName] = $role.id
  if ($existingRoleIds -contains $role.id) {
    Write-Host "  already present: '$roleName'"
    continue
  }
  Write-Host "  adding '$roleName' (id=$($role.id))"
  Invoke-Az @('ad', 'app', 'permission', 'add', '--id', $APP_ID, '--api', $GRAPH_ID, '--api-permissions', "$($role.id)=Role") | Out-Null
}

Write-Host ''
Write-Host '=== 4. Admin-consenting the app (tenant-wide) ==='
# admin-consent grants EVERY permission in requiredResourceAccess, not only the
# eight roles above. Refuse if a reused app requests anything else — the
# operator must remove (or knowingly review) the extras first.
$currentAccess = (Invoke-AzJson @('ad', 'app', 'show', '--id', $APP_ID)).requiredResourceAccess
$wantedIdSet = @($wantedRoleIds.Values)
$extras = @()
foreach ($res in @($currentAccess)) {
  foreach ($perm in @($res.resourceAccess)) {
    $isWanted = ($res.resourceAppId -eq $GRAPH_ID) -and ($perm.type -eq 'Role') -and ($wantedIdSet -contains $perm.id)
    if (-not $isWanted) {
      $label = $perm.id
      if ($res.resourceAppId -eq $GRAPH_ID) {
        $named = if ($perm.type -eq 'Role') { $graphSp.appRoles | Where-Object { $_.id -eq $perm.id } } else { $graphSp.oauth2PermissionScopes | Where-Object { $_.id -eq $perm.id } }
        if ($named) { $label = "$($named.value)" }
      }
      $extras += "  - resource=$($res.resourceAppId) $($perm.type) $label"
    }
  }
}
if ($extras.Count -gt 0) {
  Write-Host "  '$APP_NAME' requests permissions beyond the $($APP_ROLE_NAMES.Count) this sample needs:"
  $extras | ForEach-Object { Write-Host $_ }
  Write-Error "Refusing to admin-consent: consent would also grant the permissions listed above. Remove them from the app registration (Entra admin center > App registrations > $APP_NAME > API permissions) and re-run. No consent was granted and no secret was created."
  exit 1
}
Invoke-Az @('ad', 'app', 'permission', 'admin-consent', '--id', $APP_ID) | Out-Host

Write-Host ''
Write-Host '=== 5. Verifying every role is assigned (waits for propagation) ==='
$deadline = (Get-Date).AddMinutes(3)
do {
  $assignments = Invoke-AzJson @('rest', '--method', 'GET', '--uri', "https://graph.microsoft.com/v1.0/servicePrincipals/$($sp.id)/appRoleAssignments")
  $assignedIds = @($assignments.value | ForEach-Object { $_.appRoleId })
  $missing = @($APP_ROLE_NAMES | Where-Object { $assignedIds -notcontains $wantedRoleIds[$_] })
  if ($missing.Count -eq 0) { break }
  Write-Host "  waiting for: $($missing -join ', ')"
  Start-Sleep -Seconds 15
} while ((Get-Date) -lt $deadline)
if ($missing.Count -gt 0) {
  Write-Error "Admin consent did not assign: $($missing -join ', '). Grant consent as a Global Administrator and re-run. No secret was created."
  exit 1
}
Write-Host "  all $($APP_ROLE_NAMES.Count) roles assigned."

Write-Host ''
Write-Host '=== 6. Client secret ==='
$now = [DateTimeOffset]::UtcNow
$validSecrets = @($appDetails.passwordCredentials | Where-Object { [DateTimeOffset]$_.endDateTime -gt $now })
$newSecret = $null
if ($validSecrets.Count -gt 0 -and -not $RotateSecret) {
  Write-Host "  keeping the existing unexpired secret ($($validSecrets.Count) found). Pass -RotateSecret to append a new one."
} else {
  # --append keeps existing credentials, so deployments using the current
  # secret keep working until you remove it yourself.
  $cred = Invoke-AzJson @('ad', 'app', 'credential', 'reset', '--id', $APP_ID, '--append', '--years', '1', '--display-name', "cos-agent-worker-$(Get-Date -Format 'yyyyMMdd')")
  $newSecret = $cred.password
  if ($validSecrets.Count -gt 0) {
    Write-Host '  appended a new secret. Delete the old one only after .env and App Service use the new value.'
  }
}

Write-Host ''
Write-Host '========================================================='
Write-Host 'PASTE THE FOLLOWING INTO scenarios/chief-of-staff/.env'
Write-Host '========================================================='
Write-Host "GRAPH_APP_ID=$APP_ID"
if ($newSecret) {
  Write-Host "GRAPH_APP_SECRET=$newSecret"
} else {
  Write-Host 'GRAPH_APP_SECRET=<unchanged — keep your existing value>'
}
Write-Host "GRAPH_TENANT_ID=$($acct.tenantId)"
Write-Host '========================================================='

Write-Host ''
Write-Host 'One-more-thing (required for meeting transcript + insights + onlineMeeting reads):'
Write-Host '  OnlineMeetings-related Graph APIs additionally need a Teams application-access policy.'
Write-Host '  This is a TENANT-ADMIN step, done ONCE. Leaders never touch PowerShell.'
Write-Host ''
Write-Host '  Install-Module MicrosoftTeams -Force -Scope CurrentUser'
Write-Host '  Connect-MicrosoftTeams'
Write-Host "  New-CsApplicationAccessPolicy -Identity `"cos-agent-policy`" -AppIds `"$APP_ID`" -Description `"CoS Graph Worker access`""
Write-Host ''
Write-Host '  Then pick ONE of these grant strategies:'
Write-Host ''
Write-Host '  # RECOMMENDED (smallest surface): grant policy to the CoS agent UPN only.'
Write-Host '  # In .env set CAPTURE_GRAPH_OWNER=cos-agent (the default). Any meeting'
Write-Host '  # with both the leader and the CoS agent on the invite is captured.'
Write-Host '  Grant-CsApplicationAccessPolicy -PolicyName "cos-agent-policy" -Identity "<COS_AGENT_UPN>"'
Write-Host ''
Write-Host '  # Alternative: grant tenant-wide (fine for small demo tenants).'
Write-Host '  #   In .env set CAPTURE_GRAPH_OWNER=leader.'
Write-Host '  Grant-CsApplicationAccessPolicy -PolicyName "cos-agent-policy" -Global'
Write-Host ''
Write-Host '  # Alternative: per-leader (production, precise control).'
Write-Host '  #   In .env set CAPTURE_GRAPH_OWNER=leader.'
Write-Host '  Grant-CsApplicationAccessPolicy -PolicyName "cos-agent-policy" -Identity "<LEADER_UPN>"'
Write-Host ''
Write-Host 'Note: policy assignment can take up to 30 min to propagate through Teams.'
Write-Host 'Calendar, Planner, user, group, and chat-member reads need nothing else. Done.'
