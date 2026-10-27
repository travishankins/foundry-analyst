// Foundry resource, project, model deployment and the Fabric connection used by the agents.
// The agents themselves (orchestrator + sub-agents) are not ARM resources; deploy.ps1 creates them with
// backend/agents/setup_agents.py once this template has been deployed.

@description('Region for the Foundry resource. It must offer the model and the Agent Service.')
param location string

@description('Foundry resource name. Also its custom subdomain, so it must be globally unique.')
param name string

param projectName string

@description('Model for the sub-agents (report builder, Fabric). The deployment name equals the model name.')
param modelName string
param modelVersion string
param modelSku string = 'GlobalStandard'
@description('Capacity in thousands of tokens per minute.')
param modelCapacity int

@description('Orchestrator model. It owns the Learn MCP tool, which the classic Agents API does not run on gpt-5.x. Same name as modelName = one deployment.')
param orchestratorModelName string = 'gpt-4.1'
param orchestratorModelVersion string = '2025-04-14'
param orchestratorModelCapacity int = 50

@description('Fabric data agent coordinates (the GUIDs in the data agent URL: .../groups/<workspace>/aiskills/<artifact>). Both are needed to create the connection.')
param fabricWorkspaceId string = ''
param fabricArtifactId string = ''

@description('Object ID of the web app identity, which calls the agents at runtime.')
param appPrincipalId string

@description('Object ID of the person or service principal running deploy.ps1, which creates the agents. Empty skips the assignment.')
param deployerPrincipalId string = ''
@allowed([ 'User', 'ServicePrincipal' ])
param deployerPrincipalType string = 'User'

// Built-in role "Azure AI User" (now shown as "Foundry User"): data actions to run and manage agents
var foundryUserRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '53ca6127-db72-4b80-b1b0-d745d6d5456d')
var createFabricConnection = !empty(fabricWorkspaceId) && !empty(fabricArtifactId)
var separateOrchestratorModel = orchestratorModelName != modelName

resource account 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: name
  location: location
  kind: 'AIServices'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  properties: {
    allowProjectManagement: true
    customSubDomainName: name
    publicNetworkAccess: 'Enabled'
    // Entra ID only: callers use managed identity or az login, never keys
    disableLocalAuth: true
  }
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: account
  name: projectName
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    displayName: 'Foundry Analyst'
    description: 'Orchestrator, Fabric data, Microsoft Learn and report-builder agents'
  }
}

// The account serializes writes, so deployment and connection are chained instead of running in parallel
resource model 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: account
  name: modelName
  sku: {
    name: modelSku
    capacity: modelCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: modelName
      version: modelVersion
    }
  }
  dependsOn: [ project ]
}

resource orchestratorModel 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = if (separateOrchestratorModel) {
  parent: account
  name: orchestratorModelName
  sku: {
    name: modelSku
    capacity: orchestratorModelCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: orchestratorModelName
      version: orchestratorModelVersion
    }
  }
  dependsOn: [ model ]
}

resource fabricConnection 'Microsoft.CognitiveServices/accounts/projects/connections@2025-06-01' = if (createFabricConnection) {
  parent: project
  name: 'fabric-data-agent'
  properties: {
    category: 'CustomKeys'
    authType: 'CustomKeys'
    target: '_'
    isSharedToAll: true
    credentials: {
      keys: {
        workspace_id: fabricWorkspaceId
        artifact_id: fabricArtifactId
      }
    }
  }
  dependsOn: [ model, orchestratorModel ]
}

resource appAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: project
  name: guid(project.id, appPrincipalId, foundryUserRoleId)
  properties: {
    roleDefinitionId: foundryUserRoleId
    principalId: appPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource deployerAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deployerPrincipalId)) {
  scope: project
  name: guid(project.id, deployerPrincipalId, foundryUserRoleId)
  properties: {
    roleDefinitionId: foundryUserRoleId
    principalId: deployerPrincipalId
    principalType: deployerPrincipalType
  }
}

output accountName string = account.name
output projectName string = project.name
output modelDeploymentName string = model.name
output fabricConnectionId string = createFabricConnection ? fabricConnection.id : ''
