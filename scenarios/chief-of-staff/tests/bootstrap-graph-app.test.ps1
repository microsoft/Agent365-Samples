# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
$ErrorActionPreference = 'Stop'
$bootstrap = Join-Path $PSScriptRoot '..\scripts\bootstrap-graph-app.ps1'
$pwsh = (Get-Process -Id $PID).Path

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Read-Host {
  $state.Prompts++
  if ($state.Mode -in @('no-subscription-prompt', 'empty-account')) {
    return '11111111-1111-1111-1111-111111111111'
  }
  if ($state.Mode -eq 'no-subscription-invalid') { return 'not-a-tenant' }
  return ''
}

# Shadow az for offline tests. A native child process reproduces the CLI's
# nonzero exit without touching the real login or any Azure resources.
function az {
  $command = $args -join ' '
  $state.Calls.Add($command)
  if ($state.Mode -like 'secret-*') {
    $global:LASTEXITCODE = 0
    switch -Wildcard ($command) {
      'account show*' { return '{"tenantId":"11111111-1111-1111-1111-111111111111","user":{"name":"offline-test"}}' }
      'ad app list*' { return '[{"displayName":"cos-graph-worker","appId":"test-app"}]' }
      'ad sp list*' { return '[{"id":"worker-sp"}]' }
      'ad sp show*' { return (@{ appRoles = $state.Roles } | ConvertTo-Json -Depth 8 -Compress) }
      'ad app show*' {
        return (@{ requiredResourceAccess = @(@{
          resourceAppId = '00000003-0000-0000-c000-000000000000'
          resourceAccess = @($state.Roles | ForEach-Object { @{ id = $_.id; type = 'Role' } })
        }); passwordCredentials = $state.Credentials } | ConvertTo-Json -Depth 8 -Compress)
      }
      'ad app permission admin-consent*' { return }
      'rest *' { return (@{ value = @($state.Roles | ForEach-Object { @{ appRoleId = $_.id } }) } | ConvertTo-Json -Depth 8 -Compress) }
      'ad app credential reset*' { return '{"password":"offline-test-only"}' }
      default { throw "Unexpected provisioning command in offline test: $command" }
    }
  }
  if ($command -like 'login *') {
    if ($state.Mode -eq 'cancelled-login') {
      & $pwsh -NoProfile -Command "[Console]::Error.WriteLine('ERROR: login cancelled'); exit 1"
      return
    }
    $state.Renewed = $true
    $global:LASTEXITCODE = 0
    return
  }
  if ($command -like 'account show*' -and $state.Mode -eq 'empty-account' -and -not $state.Renewed) {
    $global:LASTEXITCODE = 0
    return '{}'
  }
  $missingAccount = $state.Mode -like 'missing-login*' -or $state.Mode -like 'no-subscription*'
  if ($command -like 'account show*' -and (-not $missingAccount -or $state.Renewed) -and $state.Mode -ne 'no-subscription-still-missing') {
    $global:LASTEXITCODE = 0
    if ($state.Mode -eq 'wrong-tenant' -and $state.Renewed) {
      return '{"tenantId":"22222222-2222-2222-2222-222222222222","user":{"name":"offline-test"}}'
    }
    return '{"tenantId":"11111111-1111-1111-1111-111111111111","user":{"name":"offline-test"}}'
  }
  if ($command -like 'ad app list*' -and ($state.Mode -eq 'valid-login' -or ($state.Renewed -and $state.Mode -ne 'still-revoked'))) {
    $global:LASTEXITCODE = 0
    return '[{"displayName":"cos-graph-worker","appId":"test-app"}]'
  }
  if ($command -like 'ad sp list*') {
    throw 'OFFLINE_TEST_BOUNDARY: live-login preflight passed'
  }
  $errorText = switch ($state.Mode) {
    'permission-error' { 'ERROR: Forbidden - insufficient privileges' }
    'network-error' { 'ERROR: ConnectionError' }
    default {
      if ($state.Mode -like 'no-subscription*') { "ERROR: No subscription found. Run 'az account set' to select a subscription." }
      else { 'ERROR: invalid_grant AADSTS50173' }
    }
  }
  $escapedError = $errorText.Replace("'", "''")
  & $pwsh -NoProfile -Command "[Console]::Error.WriteLine('$escapedError'); exit 1"
}

foreach ($mode in @('revoked-login', 'missing-login', 'missing-login-with-tenant', 'valid-login', 'device-code',
    'still-revoked', 'cancelled-login', 'wrong-tenant', 'permission-error', 'network-error',
    'no-subscription-with-tenant', 'no-subscription-prompt', 'no-subscription-cancelled',
    'no-subscription-invalid', 'no-subscription-still-missing', 'empty-account')) {
  $state = @{ Mode = $mode; Renewed = $false; Prompts = 0; Calls = [System.Collections.Generic.List[string]]::new() }
  $messages = [System.Collections.Generic.List[string]]::new()
  $failure = $null
  try {
    $parameters = @{}
    if ($mode -eq 'device-code') { $parameters.UseDeviceCode = $true }
    if ($mode -in @('missing-login-with-tenant', 'no-subscription-with-tenant', 'no-subscription-still-missing')) {
      $parameters.TenantId = '11111111-1111-1111-1111-111111111111'
    }
    & $bootstrap @parameters 6>&1 | ForEach-Object { $messages.Add($_.ToString()) }
  } catch {
    $failure = $_
  }
  Assert-True ($null -ne $failure) "$mode must stop at the offline boundary"
  $text = $messages -join "`n"
  $logins = @($state.Calls | Where-Object { $_ -like 'login *' })
  if ($mode -in @('valid-login', 'revoked-login', 'missing-login-with-tenant', 'device-code',
      'no-subscription-with-tenant', 'no-subscription-prompt', 'empty-account')) {
    Assert-True ($failure.Exception.Message -match 'OFFLINE_TEST_BOUNDARY') 'Valid login must reach phase 2'
    Assert-True ($text -match 'found existing') 'The preflight app lookup must be reused'
    $expectedLookups = if ($mode -in @('revoked-login', 'device-code')) { 2 } else { 1 }
    Assert-True (@($state.Calls | Where-Object { $_ -like 'ad app list*' }).Count -eq $expectedLookups) 'Reuse the successful preflight app lookup'
    Assert-True ($text -notmatch 'cached login was revoked') 'Valid login must not print recovery guidance'
    if ($mode -eq 'valid-login') {
      Assert-True ($logins.Count -eq 0) 'A healthy login must not trigger sign-in'
    } else {
      Assert-True ($logins.Count -eq 1) 'An expired login must trigger exactly one sign-in'
      Assert-True ($logins[0] -match '--tenant 11111111-1111-1111-1111-111111111111') 'Sign-in must preserve the target tenant'
      Assert-True ($logins[0] -match '--allow-no-subscriptions.*--scope https://graph.microsoft.com/.default') 'Sign-in must request Graph access for tenant-only admins'
      Assert-True ($text -match 'Retrying the live Graph check') 'Successful login must retry Graph before mutation'
      Assert-True (($logins[0] -match '--use-device-code') -eq ($mode -eq 'device-code')) 'Device-code flag must be honored'
    }
  } else {
    Assert-True ($text -match 'No app, permission, or secret was changed') 'Failure must stop before mutation'
    Assert-True ($text -match 'https://graph.microsoft.com/.default') 'Recovery must request Graph authentication'
    Assert-True ($text -match '--allow-no-subscriptions') 'Recovery must support tenant-only admin accounts'
    Assert-True ($text -notmatch '=== 1\.') 'Failed preflight must not reach provisioning'
    Assert-True (@($state.Calls | Where-Object { $_ -notlike 'account show*' -and $_ -notlike 'ad app list*' -and $_ -notlike 'login *' }).Count -eq 0) 'No provisioning command may run'
    if ($mode -in @('still-revoked', 'cancelled-login', 'wrong-tenant', 'no-subscription-still-missing')) {
      Assert-True ($logins.Count -eq 1) 'Sign-in retries must be bounded to one'
    } else {
      Assert-True ($logins.Count -eq 0) 'Unknown tenant and non-auth errors must not launch login'
    }
    $expectedPrompts = if ($mode -in @('missing-login', 'no-subscription-prompt', 'no-subscription-cancelled',
        'no-subscription-invalid', 'empty-account')) { 1 } else { 0 }
    Assert-True ($state.Prompts -eq $expectedPrompts) 'Prompt only when the target tenant is unknown'
  }
  Assert-True (@($state.Calls | Where-Object { $_ -like 'logout*' }).Count -eq 0) 'Never sign out automatically'
  Write-Host "PASS: $mode"
}

# Simulate a UTC-08:00 host's local wall clock independently of the test
# runner's zone. UTC Graph expiry values must still compare as instants.
function Get-Date {
  param([string]$Format)
  $local = [datetime]::SpecifyKind([datetime]::UtcNow.AddHours(-8), [DateTimeKind]::Local)
  if ($Format) { return $local.ToString($Format) }
  return $local
}

$roles = @('Calendars.Read', 'OnlineMeetings.Read.All', 'OnlineMeetingTranscript.Read.All',
  'OnlineMeetingAiInsight.Read.All', 'Tasks.ReadWrite.All', 'User.Read.All', 'GroupMember.Read.All', 'ChatMember.Read.All') |
  ForEach-Object { @{ id = "role-$_"; value = $_ } }
foreach ($mode in @('secret-expired', 'secret-valid', 'secret-mixed', 'secret-rotate', 'secret-missing')) {
  $expired = @{ endDateTime = [DateTimeOffset]::UtcNow.AddHours(-1).UtcDateTime.ToString('o') }
  $valid = @{ endDateTime = [DateTimeOffset]::UtcNow.AddHours(1).UtcDateTime.ToString('o') }
  $credentials = switch ($mode) {
    'secret-expired' { @($expired) }
    'secret-valid' { @($valid) }
    'secret-mixed' { @($expired, $valid) }
    'secret-rotate' { @($valid) }
    'secret-missing' { @() }
  }
  $state = @{ Mode = $mode; Roles = @($roles); Credentials = @($credentials); Calls = [System.Collections.Generic.List[string]]::new() }
  $parameters = @{ RotateSecret = ($mode -eq 'secret-rotate') }
  $messages = @(& $bootstrap @parameters 6>&1)
  $resets = @($state.Calls | Where-Object { $_ -like 'ad app credential reset*' })
  $shouldReset = $mode -in @('secret-expired', 'secret-rotate', 'secret-missing')
  Assert-True ($resets.Count -eq [int]$shouldReset) "$mode must handle secret expiry as an instant on a UTC-08:00 host"
  if ($shouldReset) {
    Assert-True ($resets[0] -match '--append') 'Replacement must retain other existing credentials'
  } else {
    Assert-True (($messages -join "`n") -match 'keeping the existing unexpired secret \(1 found\)') 'Only truly unexpired credentials may be kept'
  }
  Write-Host "PASS: $mode"
}
