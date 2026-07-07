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
// Optional (Admin Center attribution / enrichment, Option 1 + 3) — fill in the map below:
//   RunAsUserId__c — Entra user object id to attribute Agentforce sessions to, so they surface
//                    in the M365 Admin Center "Activity" tab. Blank => user-less (Defender-only).
//   BlueprintId__c — agent blueprint id for session enrichment.
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
    'OriginateEnabled__c' => false,
    // Admin Center attribution / enrichment (Option 1 + 3). Set RunAsUserId__c to a real Entra
    // (AAD) user object id so Agentforce sessions surface as run-time in the M365 Admin Center
    // "Activity" tab; leave blank to keep spans user-less (Defender-only). Others are optional.
    'RunAsUserId__c' => '',
    'BlueprintId__c' => '',
    'AgentName__c' => 'salesforce-agentforce',
    'ChannelName__c' => 'agentforce'
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
