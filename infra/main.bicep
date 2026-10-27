// Foundry Analyst: a single Linux App Service that serves the API and the web app, Log Analytics, and (unless
// mockAgents is 1) a Foundry resource + project + model deployment for the agents. One resource group.

@description('Region. Defaults to the resource group location.')
param location string = resourceGroup().location

@description('Globally unique web app name; the site is https://<name>.azurewebsites.net')
param appName string

@description('App Service plan SKU. B1 is the cheapest tier that supports Always On.')
param skuName string = 'B1'

@description('1 = scripted demo agents (no Foundry needed). 0 = deploy a Foundry project in this resource group and run the real agents.')
@allowed([ '0', '1' ])
param mockAgents string = '0'

@description('Microsoft Entra tenant and app (client) ID used for sign-in.')
param entraTenantId string
param entraClientId string

@description('Require an approver before anything is shared.')
@allowed([ '0', '1' ])
param shareRequiresApproval string = '1'

@secure()
@description('Shared secret for machine callers of POST /api/events/anomaly. Leave empty to disable the webhook.')
param eventWebhookSecret string = ''

@description('Foundry resource location (used when mockAgents is 0). It must offer the model and the Agent Service.')
param foundryLocation string = location
param modelName string = 'gpt-5.4'
param modelVersion string = '2026-03-05'
@description('Model capacity in thousands of tokens per minute.')
param modelCapacity int = 50
@description('Orchestrator model; see foundry.bicep.')
param orchestratorModelName string = 'gpt-4.1'
param orchestratorModelVersion string = '2025-04-14'
param orchestratorModelCapacity int = 50

@description('Fabric data agent workspace and artifact IDs; creates the Foundry connection used by the fabric-data-agent sub-agent.')
param fabricWorkspaceId string = ''
param fabricArtifactId string = ''

@description('Object ID of whoever runs deploy.ps1; gets the Foundry User role so the agents can be created. Empty skips it.')
param deployerPrincipalId string = ''
@allowed([ 'User', 'ServicePrincipal' ])
param deployerPrincipalType string = 'User'

@description('Created by setup_agents.py after the first deployment; deploy.ps1 passes the existing values back so redeploys keep them.')
param orchestratorAgentId string = ''
param reportBuilderAgentId string = ''

var siteUrl = 'https://${appName}.azurewebsites.net'
var useFoundry = mockAgents == '0'
// Derived from names so the site does not depend on the Foundry module (the module needs the site identity)
var foundryName = '${appName}-ai'
var foundryProjectName = 'foundry-analyst'
var projectEndpoint = useFoundry ? 'https://${foundryName}.services.ai.azure.com/api/projects/${foundryProjectName}' : ''

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${appName}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${appName}-plan'
  location: location
  kind: 'linux'
  sku: { name: skuName }
  properties: { reserved: true }
}

resource site 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    siteConfig: {
      linuxFxVersion: 'PYTHON|3.12'
      appCommandLine: 'python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips "*"'
      alwaysOn: true
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      healthCheckPath: '/api/health'
      appSettings: [
        { name: 'WEBSITES_PORT', value: '8000' }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }
        { name: 'MOCK_AGENTS', value: mockAgents }
        { name: 'AUTH_MODE', value: 'entra' }
        { name: 'ENTRA_TENANT_ID', value: entraTenantId }
        { name: 'ENTRA_CLIENT_ID', value: entraClientId }
        // /home is persistent storage on App Service; the library, approvals and audit log live here
        { name: 'DATA_DIR', value: '/home/data' }
        { name: 'ALLOWED_ORIGINS', value: siteUrl }
        { name: 'SHARE_REQUIRES_APPROVAL', value: shareRequiresApproval }
        { name: 'EVENT_WEBHOOK_SECRET', value: eventWebhookSecret }
        { name: 'PROJECT_ENDPOINT', value: projectEndpoint }
        { name: 'MODEL_DEPLOYMENT_NAME', value: modelName }
        { name: 'ORCHESTRATOR_MODEL_DEPLOYMENT_NAME', value: orchestratorModelName }
        { name: 'ORCHESTRATOR_AGENT_ID', value: orchestratorAgentId }
        { name: 'REPORT_BUILDER_AGENT_ID', value: reportBuilderAgentId }
      ]
    }
  }
}

module foundry 'foundry.bicep' = if (useFoundry) {
  name: 'foundry'
  params: {
    location: foundryLocation
    name: foundryName
    projectName: foundryProjectName
    modelName: modelName
    modelVersion: modelVersion
    modelCapacity: modelCapacity
    orchestratorModelName: orchestratorModelName
    orchestratorModelVersion: orchestratorModelVersion
    orchestratorModelCapacity: orchestratorModelCapacity
    fabricWorkspaceId: fabricWorkspaceId
    fabricArtifactId: fabricArtifactId
    appPrincipalId: site.identity.principalId
    deployerPrincipalId: deployerPrincipalId
    deployerPrincipalType: deployerPrincipalType
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-log-analytics'
  scope: site
  properties: {
    workspaceId: logs.id
    logs: [
      { category: 'AppServiceHTTPLogs', enabled: true }
      { category: 'AppServiceConsoleLogs', enabled: true }
      { category: 'AppServiceAppLogs', enabled: true }
      { category: 'AppServiceAuditLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output siteUrl string = siteUrl
output siteName string = site.name
output principalId string = site.identity.principalId
output logWorkspace string = logs.name
output projectEndpoint string = projectEndpoint
output modelDeploymentName string = modelName
output orchestratorModelDeploymentName string = orchestratorModelName
output fabricConnectionId string = useFoundry ? foundry!.outputs.fabricConnectionId : ''
