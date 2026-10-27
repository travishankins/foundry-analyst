<#
.SYNOPSIS
  Clears the demo data (library, approvals, incidents, audit log, thread ownership) on the deployed site and restarts it.
.EXAMPLE
  ./reset-demo.ps1
#>
param(
  [string] $ResourceGroup = 'rg-foundry-analyst',
  [string] $AppName
)

$ErrorActionPreference = 'Stop'
if (-not $AppName) {
  # Same derivation as deploy.ps1
  $subId = az account show --query id -o tsv
  $hash = [Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes("$subId/$ResourceGroup"))
  $AppName = 'foundry-analyst-' + (($hash | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 6)
}

Write-Host "Clearing /home/data on $AppName..."
$kudu = "https://$AppName.scm.azurewebsites.net/api/command"

# Kudu runs commands without a shell, so use find (which matches *.json itself) rather than rm with a glob
function Invoke-Kudu([string] $Command) {
  $tmp = [IO.Path]::GetTempFileName()
  [IO.File]::WriteAllText($tmp, (@{ command = $Command; dir = '/home' } | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
  try {
    $out = az rest --method post --url $kudu --resource 'https://management.azure.com/' `
      --headers 'Content-Type=application/json' --body "@$tmp" --only-show-errors -o json
    if ($LASTEXITCODE -ne 0) { throw 'Could not reach the site''s management endpoint' }
    $result = $out | ConvertFrom-Json
    if ($result.ExitCode -ne 0) { throw "Command failed: $($result.Error)" }
    $result.Output
  } finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
}

Invoke-Kudu 'find /home/data -maxdepth 1 -name *.json -delete' | Out-Null
if ((Invoke-Kudu 'find /home/data -maxdepth 1 -name *.json') -match '\S') { throw 'Data files are still present after the delete' }

az webapp restart -g $ResourceGroup -n $AppName
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep 5
  try { if ((Invoke-RestMethod "https://$AppName.azurewebsites.net/api/health" -TimeoutSec 15).status -eq 'ok') { Write-Host 'Reset complete. The site is healthy and empty.'; return } } catch { }
}
throw 'The site did not come back healthy after the restart'
