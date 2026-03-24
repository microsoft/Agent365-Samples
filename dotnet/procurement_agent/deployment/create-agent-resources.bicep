// Bicep script to create resources for Hello World agent
// Currently creates storage account with two tables and an Azure AI Foundry resource with a model deployment
// After login with 'az login', deploy by running:
// az deployment group create --resource-group <your-rg> --template-file create-agent-resources.bicep --parameters storageAccountName=<your-storage-account-name> aiFoundryName=<your-ai-foundry-name>

param location string = resourceGroup().location

// Update these parameters to your desired values
param storageAccountName string = 'a365procagentstorage' // Must be globally unique
param agentApplicationEntitiesTable string = 'AgentApplicationEntitiesV1'
param agentsTable string = 'Agents'
param aiFoundryName string = 'a365aifoundry'// Must be globally unique
param kvName string = 'a365-proc-agent-kv' // Key Vault name

// Storage Account
resource storageAccount 'Microsoft.Storage/storageAccounts@2025-01-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    supportsHttpsTrafficOnly: true
  }
}

// Table Storage - two tables under the storage account (requires table service)
resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2025-01-01' = {
  parent: storageAccount
  name: 'default'
  properties: {}
}

resource table1 'Microsoft.Storage/storageAccounts/tableServices/tables@2025-01-01' = {
  parent: tableService
  name: agentApplicationEntitiesTable
  properties: {}
}

resource table2 'Microsoft.Storage/storageAccounts/tableServices/tables@2025-01-01' = {
  parent: tableService
  name: agentsTable
  properties: {}
}

// Azure AI Foundry with model deployment
resource aiFoundry 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: aiFoundryName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  sku: {
    name: 'S0'
  }
  kind: 'AIServices'
  properties: {
    allowProjectManagement: true
    customSubDomainName: aiFoundryName
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource modelDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: aiFoundry
  name: 'gpt-4.1'
  sku: {
    capacity: 1
    name: 'GlobalStandard'
  }
  properties: {
    model: {
      name: 'gpt-4.1'
      format: 'OpenAI'
    }
  }
}

  // Key Vault
resource keyVault 'Microsoft.KeyVault/vaults@2025-05-01' = {
  name: kvName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: {
      name: 'standard'
      family: 'A'
    }
    accessPolicies: [
      {
        tenantId: subscription().tenantId
        objectId: aiFoundry.identity.principalId
        permissions: {
          secrets: [
            'get'
            'list'
            'set'
            'delete'
          ]
        }
      }
    ]
    enabledForDeployment: true
    enabledForDiskEncryption: true
    enabledForTemplateDeployment: true
  }
}
