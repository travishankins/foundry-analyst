<#
.SYNOPSIS
  Creates three demo users (Analyst, Approver, Viewer) in your Entra tenant and assigns them app roles.
  Prints their passwords once. Safe to re-run: existing users keep their password and just get their role.

.EXAMPLE
  ./demo-users.ps1
  ./demo-users.ps1 -Remove     # deletes the demo users again
#>
param(
  [string] $ResourceGroup = 'rg-foundry-analyst',
  [string] $Domain,
  [switch] $Remove
)

$ErrorActionPreference = 'Stop'
if (-not $Domain) { $Domain = (az ad signed-in-user show --query userPrincipalName -o tsv).Split('@')[1] }

$people = @(
  @{ nick = 'demo.analyst';  name = 'Demo Analyst';  role = 'Analyst' },
  @{ nick = 'demo.approver'; name = 'Demo Approver'; role = 'Approver' },
  @{ nick = 'demo.viewer';   name = 'Demo Viewer';   role = 'Viewer' }
)

function New-Password {
  $chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!#%+='
  $bytes = New-Object byte[] 20
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  # Guarantee all complexity classes, then random fill
  'Aa3!' + (($bytes | ForEach-Object { $chars[$_ % $chars.Length] }) -join '')
}

if ($Remove) {
  foreach ($p in $people) {
    $upn = "$($p.nick)@$Domain"
    az ad user delete --id $upn --only-show-errors 2>$null
    Write-Host "Removed $upn (if it existed)"
  }
  return
}

$created = @()
foreach ($p in $people) {
  $upn = "$($p.nick)@$Domain"
  $exists = az ad user list --filter "userPrincipalName eq '$upn'" --query '[0].id' -o tsv --only-show-errors
  if ($exists) { Write-Host "$upn already exists"; continue }
  $password = New-Password
  az ad user create --display-name $p.name --user-principal-name $upn --mail-nickname $p.nick `
    --password $password --force-change-password-next-sign-in false --only-show-errors -o none
  if ($LASTEXITCODE -ne 0) { throw "Could not create $upn" }
  $created += [pscustomobject]@{ User = $upn; Role = $p.role; Password = $password }
  Write-Host "Created $upn"
}

# Role assignment reuses the app setup script
$hash = [Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes("$(az account show --query id -o tsv)/$ResourceGroup"))
$site = 'https://foundry-analyst-' + (($hash | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 6) + '.azurewebsites.net'
$assign = $people | ForEach-Object { "$($_.nick)@${Domain}:$($_.role)" }
& "$PSScriptRoot/entra.ps1" -SiteUrl $site -Assign $assign | Out-Null

if ($created) {
  Write-Host "`nPasswords (shown once):" -ForegroundColor Yellow
  $created | Format-Table -AutoSize | Out-String | Write-Host
}
Write-Host 'Sign in to each from a separate browser profile (or InPrivate window).'
Write-Host 'If your tenant enforces MFA, each user has to complete registration on first sign-in.'
