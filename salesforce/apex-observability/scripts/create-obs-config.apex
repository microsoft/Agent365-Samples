// Seeds (creates/updates) the A365_Observability_Config.Default Custom Metadata record.
//
// CMDT *records* can fail to deploy via the Metadata API / sf CLI on some orgs (opaque
// UNKNOWN_EXCEPTION), so create/update them through the Apex Metadata API instead. The CMDT
// *type + fields* deploy normally with `sf project deploy start`.
//
// >>> EDIT the <<...>> placeholders below before running. <<<
//   <<TENANT_ID>>  — your Entra tenant id
//   <<AGENT_ID>>   — the Agent 365 agent id (the agentId in the ingest URL; token azp must match)
//
// Run:
//   sf apex run --file scripts/create-obs-config.apex --target-org <<ORG_ALIAS>>
//
// Non-secret config only. The blueprint client secret is entered in Setup on the
// A365_Obs_Entra External Credential (BlueprintBasicAuth) — never here, never in git.
Metadata.CustomMetadata cm = new Metadata.CustomMetadata();
cm.fullName = 'A365_Observability_Config.Default';
cm.label = 'Default';
Map<String, Object> vals = new Map<String, Object>{
    'Enabled__c' => true,
    'TenantId__c' => '<<TENANT_ID>>',
    'AgentId__c' => '<<AGENT_ID>>',
    'IngestBase__c' => 'https://agent365.svc.cloud.microsoft',
    'ObsScope__c' => 'api://9b975845-388f-4429-889e-eab1ef63949c/.default',
    'FmiScope__c' => 'api://AzureADTokenExchange/.default',
    'UseS2SEndpoint__c' => true,
    'ServiceName__c' => 'salesforce-apex',
    // Origination (Agentforce-native) fields — set OriginateEnabled__c = true only if you
    // build the optional Agentforce agent (see ../agent/README.md).
    'AgentforceServiceName__c' => 'salesforce-agentforce',
    'OriginateEnabled__c' => false
};
for (String f : vals.keySet()) {
    Metadata.CustomMetadataValue v = new Metadata.CustomMetadataValue();
    v.field = f;
    v.value = vals.get(f);
    cm.values.add(v);
}
Metadata.DeployContainer container = new Metadata.DeployContainer();
container.addMetadata(cm);
Id jobId = Metadata.Operations.enqueueDeployment(container, null);
System.debug('A365_Observability_Config.Default deploy enqueued: ' + jobId);
