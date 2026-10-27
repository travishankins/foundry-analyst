<#
.SYNOPSIS
  Deploys Foundry Analyst to Azure in a single resource group (default: rg-foundry-analyst in centralus).

.DESCRIPTION
  1. Checks the subscription is enabled
  2. Creates/updates the Entra app registration and role assignments (entra.ps1)
  3. Builds the web app and packages the backend + web app (package.py)
  4. Deploys infra/main.bicep: App Service + Log Analytics, and (unless -MockAgents 1) a Foundry resource,
     project, model deployment and the Fabric data agent connection (infra/foundry.bicep)
  5. Creates or updates the Foundry agents with backend/agents/setup_agents.py: the orchestrator (which also owns the
     Microsoft Learn MCP tool) and its sub-agents report-builder and, with Fabric, fabric-data-agent
     with backend/agents/setup_agents.py and points the web app at them
  6. Zip-deploys the package and smoke-tests the site

  Safe to re-run: it updates in place, keeps the existing webhook secret and upserts the agents by name.

  Real agents need a published Fabric data agent: pass its workspace and artifact IDs (the GUIDs in its URL,
  .../groups/<workspace>/aiskills/<artifact>). Use -MockAgents 1 for the scripted demo agents with no Foundry.
  Note: Microsoft is retiring the Fabric data agent tool in Foundry Agent Service on 2026-11-06 (replaced by Fabric IQ).

.EXAMPLE
  ./deploy.ps1 -FabricWorkspaceId <guid> -FabricArtifactId <guid>
  ./deploy.ps1 -FabricWorkspaceId <guid> -FabricArtifactId <guid> -Assign 'ada@contoso.com:Approver','victor@contoso.com:Viewer'
  ./deploy.ps1 -SkipFabric        # Foundry + orchestrator and report-builder agents; no Fabric needed
  ./deploy.ps1 -MockAgents 1
#>
param(
  [string] $SubscriptionId = (az account show --query id -o tsv),
  [string] $ResourceGroup = 'rg-foundry-analyst',
  [string] $Location = 'centralus',
  [string] $Sku = 'B1',
  [ValidateSet('0', '1')] [string] $MockAgents = '0',
  [string] $FabricWorkspaceId = '',
  [string] $FabricArtifactId = '',
  [switch] $SkipFabric,
  [string] $FoundryLocation = $Location,
  [string] $ModelName = 'gpt-5.4',
  [string] $ModelVersion = '2026-03-05',
  [int] $ModelCapacity = 50,
  [string] $OrchestratorModelName = 'gpt-4.1',
  [string] $OrchestratorModelVersion = '2025-04-14',
  [int] $OrchestratorModelCapacity = 50,
  [ValidateSet('0', '1')] [string] $ShareRequiresApproval = '1',
  [string[]] $Assign = @(),
  [string] $ServiceManagementReference = '',   # Service Tree ID, for tenants that require it on new app registrations
  [string] $ClientId = '',                     # reuse an existing app registration instead of creating one (it needs the SPA redirect URI, access_as_user scope and app roles; see entra.ps1)
  [switch] $SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$useFoundry = $MockAgents -eq '0'

function Step([string] $Message) { Write-Host "`n== $Message" -ForegroundColor Cyan }
function Run([scriptblock] $Command, [string] $Failure) {
  $out = & $Command 2>&1
  if ($LASTEXITCODE -ne 0) { throw "$Failure`n$out" }
  $out
}

function Get-BackendPython {
  $backend = Join-Path $root 'backend'
  $venv = Join-Path $backend '.venv'
  $py = if ($env:OS -eq 'Windows_NT') { Join-Path $venv 'Scripts/python.exe' } else { Join-Path $venv 'bin/python' }
  if (-not (Test-Path $py)) {
    python -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create backend/.venv' }
  }
  & $py -c 'import azure.ai.agents, azure.identity, dotenv, pydantic' 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'Installing the backend requirements...'
    & $py -m pip install -q -r (Join-Path $backend 'requirements.txt') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }
  }
  $py
}

if ($useFoundry -and -not $SkipFabric) {
  foreach ($key in 'FabricWorkspaceId', 'FabricArtifactId') {
    $parsed = [guid]::Empty
    if (-not [guid]::TryParse((Get-Variable $key -ValueOnly), [ref] $parsed)) {
      throw "-$key must be a GUID. Copy both IDs from the Fabric data agent URL (.../groups/<workspace>/aiskills/<artifact>), or pass -SkipFabric to deploy Foundry and the agents without the Fabric data agent, or -MockAgents 1 for the scripted demo."
    }
  }
}

Step 'Checking the subscription'
az account set --subscription $SubscriptionId
$sub = az account show -o json | ConvertFrom-Json
if ($sub.state -ne 'Enabled') {
  throw "Subscription '$($sub.name)' is $($sub.state). Azure blocks all writes until it is re-enabled (portal > Subscriptions), then run this script again."
}
Write-Host "$($sub.name) ($($sub.id)) in tenant $($sub.tenantId)"

# Deterministic and globally unique per subscription + resource group, so re-runs hit the same site
$hash = [Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes("$SubscriptionId/$ResourceGroup"))
$appName = 'foundry-analyst-' + (($hash | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 6)
$siteUrl = "https://$appName.azurewebsites.net"

Step 'Entra ID app registration and roles'
if ($ClientId) {
  Write-Host "Using the existing app registration $ClientId (not creating or changing one)"
  $entra = [pscustomobject]@{ tenantId = $sub.tenantId; clientId = $ClientId }
} else {
  $entra = & "$PSScriptRoot/entra.ps1" -SiteUrl $siteUrl -Assign $Assign -ServiceManagementReference $ServiceManagementReference | Select-Object -Last 1 | ConvertFrom-Json
}

Step "Resource group $ResourceGroup ($Location)"
Run { az group create --name $ResourceGroup --location $Location --tags app=foundry-analyst -o none } 'Could not create the resource group' | Out-Null
$providers = @('Microsoft.Web', 'Microsoft.OperationalInsights', 'Microsoft.Insights')
if ($useFoundry) { $providers += 'Microsoft.CognitiveServices' }
foreach ($ns in $providers) {
  if ((az provider show --namespace $ns --query registrationState -o tsv) -ne 'Registered') {
    Write-Host "Registering $ns..."
    az provider register --namespace $ns --wait
  }
}

if ($useFoundry) {
  $foundryName = "$appName-ai"
  $usageList = az cognitiveservices usage list --location $FoundryLocation -o json | ConvertFrom-Json
  $wanted = [ordered]@{ $ModelName = $ModelCapacity }
  if ($OrchestratorModelName -ne $ModelName) { $wanted[$OrchestratorModelName] = $OrchestratorModelCapacity }
  foreach ($model in $wanted.Keys) {
    Step "Checking $model quota in $FoundryLocation"
    # Usage names drop punctuation inconsistently (gpt-5.4 vs gpt4.1), so compare with dots and hyphens removed
    $key = $model -replace '[.-]', ''
    $usage = $usageList | Where-Object { ($_.name.value -replace '[.-]', '') -like "*GlobalStandard$key" } | Select-Object -First 1
    if (-not $usage) {
      Write-Warning "Could not read $model quota in $FoundryLocation; the deployment will fail if there is none."
      continue
    }
    # On a re-run the existing deployment already holds its capacity, which is reused rather than added
    $held = az cognitiveservices account deployment show -g $ResourceGroup -n $foundryName --deployment-name $model --query sku.capacity -o tsv 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $held) { $held = 0 }
    $free = $usage.limit - $usage.currentValue + [int] $held
    Write-Host "GlobalStandard $model : $free of $($usage.limit) available (need $($wanted[$model]))"
    if ($free -lt $wanted[$model]) {
      throw "Not enough $model quota in $FoundryLocation. Request quota in the portal or lower the capacity parameter (thousands of tokens per minute)."
    }
  }
}

if (-not $SkipBuild) {
  Step 'Building the web app'
  Push-Location $root
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
  } finally { Pop-Location }
}
Step 'Packaging'
$zip = Join-Path ([IO.Path]::GetTempPath()) 'foundry-analyst.zip'
python "$PSScriptRoot/package.py" $zip
if ($LASTEXITCODE -ne 0) { throw 'Packaging failed' }

# Existing app settings keep the webhook secret and the agent IDs stable across redeploys
$existing = @{}
$list = az webapp config appsettings list -g $ResourceGroup -n $appName -o json 2>$null
if ($LASTEXITCODE -eq 0 -and $list) { ($list | ConvertFrom-Json) | ForEach-Object { $existing[$_.name] = $_.value } }

$secret = $existing['EVENT_WEBHOOK_SECRET']
if (-not $secret) {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $secret = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
  $newSecret = $true
}

# Whoever runs this script creates the agents, so they need the Foundry User role on the project
$deployerId = ''
$deployerType = 'User'
if ($useFoundry) {
  if ($sub.user.type -eq 'user') {
    $deployerId = az ad signed-in-user show --query id -o tsv
  } else {
    $deployerType = 'ServicePrincipal'
    $deployerId = az ad sp show --id $sub.user.name --query id -o tsv
  }
  if (-not $deployerId) { Write-Warning 'Could not resolve your object ID; assign yourself the Foundry User role on the project or agent creation will fail.' }
}

Step 'Deploying infrastructure'
$parameters = @(
  "appName=$appName", "skuName=$Sku", "mockAgents=$MockAgents", "shareRequiresApproval=$ShareRequiresApproval",
  "entraTenantId=$($entra.tenantId)", "entraClientId=$($entra.clientId)", "eventWebhookSecret=$secret"
)
if ($useFoundry) {
  $parameters += "foundryLocation=$FoundryLocation", "modelName=$ModelName", "modelVersion=$ModelVersion", "modelCapacity=$ModelCapacity",
    "orchestratorModelName=$OrchestratorModelName", "orchestratorModelVersion=$OrchestratorModelVersion",
    "orchestratorModelCapacity=$OrchestratorModelCapacity", "deployerPrincipalType=$deployerType"
  if (-not $SkipFabric) { $parameters += "fabricWorkspaceId=$FabricWorkspaceId", "fabricArtifactId=$FabricArtifactId" }
  if ($deployerId) { $parameters += "deployerPrincipalId=$deployerId" }
  foreach ($pair in @{ orchestratorAgentId = 'ORCHESTRATOR_AGENT_ID'; reportBuilderAgentId = 'REPORT_BUILDER_AGENT_ID' }.GetEnumerator()) {
    if ($existing[$pair.Value]) { $parameters += "$($pair.Key)=$($existing[$pair.Value])" }
  }
}
Run {
  az deployment group create -g $ResourceGroup --name foundry-analyst --template-file "$PSScriptRoot/main.bicep" --parameters @parameters -o none
} 'Infrastructure deployment failed' | Out-Null

if ($useFoundry) {
  Step 'Creating the Foundry agents (orchestrator and sub-agents)'
  $outputs = (az deployment group show -g $ResourceGroup -n foundry-analyst --query properties.outputs -o json | ConvertFrom-Json)
  $env:PROJECT_ENDPOINT = $outputs.projectEndpoint.value
  $env:MODEL_DEPLOYMENT_NAME = $outputs.modelDeploymentName.value
  $env:ORCHESTRATOR_MODEL_DEPLOYMENT_NAME = $outputs.orchestratorModelDeploymentName.value
  $env:FABRIC_CONNECTION_ID = $outputs.fabricConnectionId.value
  Write-Host "Project: $($env:PROJECT_ENDPOINT)"
  $py = Get-BackendPython
  $agentArgs = @('-m', 'agents.setup_agents', '--json')
  if ($SkipFabric) { $agentArgs += '--no-fabric' }

  # A fresh role assignment can take several minutes to reach the Agent Service data plane
  $ids = $null
  for ($attempt = 1; $attempt -le 12 -and -not $ids; $attempt++) {
    Push-Location (Join-Path $root 'backend')
    try {
      $ErrorActionPreference = 'Continue'
      $out = & $py @agentArgs 2>&1 | ForEach-Object { "$_" }
      $code = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = 'Stop'
      Pop-Location
    }
    if ($code -eq 0) {
      $ids = $out | Select-Object -Last 1 | ConvertFrom-Json
      if ($out.Count -gt 1) { $out[0..($out.Count - 2)] | Write-Host }
      break
    }
    if (($out -join "`n") -notmatch 'PermissionDenied|AuthorizationFailed|Forbidden|403|PrincipalNotFound|DefaultAzureCredential') {
      throw "Creating the agents failed:`n$($out -join "`n")"
    }
    Write-Host "Waiting for the role assignment to propagate (attempt $attempt of 12)..."
    Start-Sleep 30
  }
  if (-not $ids) { throw 'The Foundry agents could not be created because access was not granted in time. Re-run deploy.ps1 in a few minutes.' }

  Run {
    az webapp config appsettings set -g $ResourceGroup -n $appName -o none --settings `
      "ORCHESTRATOR_AGENT_ID=$($ids.ORCHESTRATOR_AGENT_ID)" "REPORT_BUILDER_AGENT_ID=$($ids.REPORT_BUILDER_AGENT_ID)"
  } 'Could not set the agent IDs on the web app' | Out-Null
}

Step 'Deploying the app (the first build takes a few minutes)'
# Kudu can answer 403/5xx for a short while after the app settings change and the site restarts
for ($attempt = 1; $attempt -le 4; $attempt++) {
  $deployOut = az webapp deploy -g $ResourceGroup -n $appName --src-path $zip --type zip --timeout 900000 -o none 2>&1
  if ($LASTEXITCODE -eq 0) { break }
  if ($attempt -eq 4) { throw "App deployment failed`n$deployOut" }
  Write-Host "Deployment attempt $attempt failed; retrying in 45s..."
  Start-Sleep 45
}

Step 'Waiting for the site'
$healthy = $false
for ($i = 0; $i -lt 40 -and -not $healthy; $i++) {
  try { $healthy = (Invoke-RestMethod "$siteUrl/api/health" -TimeoutSec 15).status -eq 'ok' } catch { Start-Sleep 10 }
}
if (-not $healthy) { throw "The site did not become healthy. Check logs: az webapp log tail -g $ResourceGroup -n $appName" }
$config = Invoke-RestMethod "$siteUrl/api/auth/config"
if ($config.mode -ne 'entra') { throw "Expected Entra sign-in but the site reports '$($config.mode)'" }
$page = Invoke-WebRequest $siteUrl -UseBasicParsing -TimeoutSec 30
if ($page.StatusCode -ne 200) { throw "The web app returned $($page.StatusCode)" }

Write-Host "`nDeployed." -ForegroundColor Green
Write-Host "  URL:            $siteUrl"
Write-Host "  Sign-in:        Microsoft Entra ID, tenant $($entra.tenantId), app $($entra.clientId)"
Write-Host "  Agents:         $(if ($useFoundry) { "Foundry project $($outputs.projectEndpoint.value); orchestrator on $OrchestratorModelName with a report-builder sub-agent on $ModelName$(if ($SkipFabric) { ', no Fabric' } else { ' and a Fabric data sub-agent' })" } else { 'scripted demo agents (no Foundry)' })"
Write-Host "  Resource group: $ResourceGroup ($Location)"
if ($newSecret) { Write-Host "  Event webhook secret (shown once; send as X-Webhook-Secret): $secret" }
Write-Host "  Logs:           az webapp log tail -g $ResourceGroup -n $appName"
