<#
.SYNOPSIS
  Creates (or updates) the Entra ID app registration used for sign-in and roles. Safe to re-run.

.DESCRIPTION
  One single-tenant app serves as both the SPA and the API:
    - SPA redirect URIs for the site (and localhost for development)
    - API scope access_as_user, pre-authorized for the app itself so users are not prompted
    - App roles Viewer, Analyst, Approver, Admin
    - Enterprise app with "assignment required", and the given users assigned to roles
  Prints the tenant and client IDs as JSON on the last line.

.EXAMPLE
  ./entra.ps1 -SiteUrl https://foundry-analyst-ab12cd.azurewebsites.net
  ./entra.ps1 -SiteUrl https://... -Assign 'ada@contoso.com:Approver','victor@contoso.com:Viewer'
#>
param(
  [Parameter(Mandatory)] [string] $SiteUrl,
  [string] $DisplayName = 'Foundry Analyst',
  [string[]] $Assign = @(),   # 'user@domain:Role'. The signed-in user is always assigned Admin.
  [string] $ServiceManagementReference = ''   # Service Tree ID; some tenants refuse to create app registrations without it
)

$ErrorActionPreference = 'Stop'
$Roles = @(
  @{ value = 'Viewer';   description = 'Browse the shared library' },
  @{ value = 'Analyst';  description = 'Create, publish and share artifacts, raise events' },
  @{ value = 'Approver'; description = 'Approve or reject requested actions and view governance' },
  @{ value = 'Admin';    description = 'All permissions, and can unpublish any artifact' }
)

function Invoke-Graph([string] $Method, [string] $Path, $Body = $null) {
  $azArgs = @('rest', '--method', $Method, '--url', "https://graph.microsoft.com/v1.0$Path", '--only-show-errors')
  $tmp = $null
  if ($null -ne $Body) {
    $tmp = [IO.Path]::GetTempFileName()
    [IO.File]::WriteAllText($tmp, ($Body | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding $false))
    $azArgs += @('--headers', 'Content-Type=application/json', '--body', "@$tmp")
  }
  try {
    $out = & az @azArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Graph $Method $Path failed: $out" }
    if ($out) { return ($out | Out-String | ConvertFrom-Json) }
  } finally { if ($tmp) { Remove-Item $tmp -ErrorAction SilentlyContinue } }
}

$tenantId = (az account show --query tenantId -o tsv)
$spaUris = @($SiteUrl.TrimEnd('/'), 'http://localhost:3000')

# --- application ---
$existing = Invoke-Graph GET "/applications?`$filter=displayName eq '$DisplayName'&`$select=id,appId,appRoles,api,spa"
$app = $existing.value | Select-Object -First 1

if (-not $app) {
  Write-Host "Creating app registration '$DisplayName'..."
  $scopeId = [guid]::NewGuid().ToString()
  $appRoles = $Roles | ForEach-Object {
    @{ id = [guid]::NewGuid().ToString(); value = $_.value; displayName = $_.value; description = $_.description
       allowedMemberTypes = @('User'); isEnabled = $true }
  }
  $api = @{
    requestedAccessTokenVersion = 2
    oauth2PermissionScopes = @(@{
      id = $scopeId; value = 'access_as_user'; type = 'User'; isEnabled = $true
      adminConsentDisplayName = 'Access Foundry Analyst'; adminConsentDescription = 'Use Foundry Analyst on behalf of the signed-in user.'
      userConsentDisplayName = 'Access Foundry Analyst'; userConsentDescription = 'Use Foundry Analyst on your behalf.'
    })
  }
  $newApp = @{
    displayName = $DisplayName; signInAudience = 'AzureADMyOrg'
    spa = @{ redirectUris = $spaUris }; api = $api; appRoles = $appRoles
  }
  if ($ServiceManagementReference) { $newApp.serviceManagementReference = $ServiceManagementReference }
  $app = Invoke-Graph POST '/applications' $newApp
  $api.preAuthorizedApplications = @(@{ appId = $app.appId; delegatedPermissionIds = @($scopeId) })
  Invoke-Graph PATCH "/applications/$($app.id)" @{ identifierUris = @("api://$($app.appId)"); api = $api } | Out-Null
  $app = Invoke-Graph GET "/applications/$($app.id)?`$select=id,appId,appRoles,api,spa"
} else {
  Write-Host "Reusing app registration '$DisplayName' ($($app.appId))"
  $merged = @($app.spa.redirectUris) + $spaUris | Where-Object { $_ } | Select-Object -Unique
  Invoke-Graph PATCH "/applications/$($app.id)" @{ spa = @{ redirectUris = @($merged) } } | Out-Null
}

# --- enterprise app (service principal) ---
$sp = (Invoke-Graph GET "/servicePrincipals?`$filter=appId eq '$($app.appId)'&`$select=id").value | Select-Object -First 1
if (-not $sp) {
  for ($i = 0; $i -lt 6 -and -not $sp; $i++) {
    try { $sp = Invoke-Graph POST '/servicePrincipals' @{ appId = $app.appId } }
    catch { Write-Host 'Waiting for the app registration to replicate...'; Start-Sleep 5 }
  }
  if (-not $sp) { throw 'Could not create the service principal' }
}
Invoke-Graph PATCH "/servicePrincipals/$($sp.id)" @{ appRoleAssignmentRequired = $true } | Out-Null

# --- role assignments ---
function Add-Assignment([string] $PrincipalId, [string] $Label, [string] $RoleName) {
  $role = $app.appRoles | Where-Object { $_.value -eq $RoleName }
  if (-not $role) { throw "Unknown role '$RoleName'. Use Viewer, Analyst, Approver or Admin." }
  $have = (Invoke-Graph GET "/servicePrincipals/$($sp.id)/appRoleAssignedTo").value |
    Where-Object { $_.principalId -eq $PrincipalId -and $_.appRoleId -eq $role.id }
  if ($have) { Write-Host "  $Label already has $RoleName"; return }
  Invoke-Graph POST "/servicePrincipals/$($sp.id)/appRoleAssignedTo" @{
    principalId = $PrincipalId; resourceId = $sp.id; appRoleId = $role.id } | Out-Null
  Write-Host "  $Label -> $RoleName"
}

Write-Host 'Assigning roles:'
$me = az ad signed-in-user show --query '{id:id,upn:userPrincipalName}' -o json | ConvertFrom-Json
Add-Assignment $me.id $me.upn 'Admin'
foreach ($entry in $Assign) {
  $upn, $roleName = $entry -split ':', 2
  $user = Invoke-Graph GET "/users/$([uri]::EscapeDataString($upn))?`$select=id"
  Add-Assignment $user.id $upn $roleName
}

@{ tenantId = $tenantId; clientId = $app.appId } | ConvertTo-Json -Compress
