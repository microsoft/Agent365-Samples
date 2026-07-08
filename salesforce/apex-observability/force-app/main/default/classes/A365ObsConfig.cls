// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// A365ObsConfig — thin reader over the A365_Observability_Config__mdt 'Default' record.
//
// Centralizes the non-secret runtime config (enable flag, ids, endpoints, scopes) so the
// emitter, token service and queueable read one source of truth. NEVER holds secrets —
// the blueprint secret lives only in the External Credential (Setup-entered).
//
// Resilient by design: if the Default record is missing (e.g. a fresh scratch org), the
// reader falls back to built-in default constants so the pipeline degrades gracefully rather
// than throwing. Tests can force a config via the @TestVisible override.
public with sharing class A365ObsConfig {

    // Default fallbacks — used only when the Default CMDT record is absent.
    @TestVisible private static final String DEF_TENANT = '11111111-1111-1111-1111-111111111111';
    @TestVisible private static final String DEF_AGENT = '22222222-2222-2222-2222-222222222222';
    @TestVisible private static final String DEF_INGEST_BASE = 'https://agent365.svc.cloud.microsoft';
    @TestVisible private static final String DEF_OBS_SCOPE = 'api://9b975845-388f-4429-889e-eab1ef63949c/.default';
    @TestVisible private static final String DEF_FMI_SCOPE = 'api://AzureADTokenExchange/.default';
    @TestVisible private static final String DEF_SERVICE_NAME = 'salesforce-apex';
    @TestVisible private static final String DEF_AF_SERVICE_NAME = 'salesforce-agentforce';

    // Test override — when set, getInstance() returns this instead of querying CMDT
    // (CMDT rows cannot be inserted in tests, so this is how disabled/enabled is exercised).
    @TestVisible private static A365_Observability_Config__mdt overrideRecord;

    // Cached per-transaction so repeated reads don't re-query.
    private static A365_Observability_Config__mdt cached;

    @TestVisible
    private static A365_Observability_Config__mdt getInstance() {
        if (overrideRecord != null) {
            return overrideRecord;
        }
        if (cached == null) {
            cached = A365_Observability_Config__mdt.getInstance('Default');
        }
        return cached;
    }

    public static Boolean isEnabled() {
        A365_Observability_Config__mdt c = getInstance();
        // Absent record => treat as DISABLED (fail-safe: never emit without explicit config).
        return c != null && c.Enabled__c == true;
    }

    public static String tenantId() {
        A365_Observability_Config__mdt c = getInstance();
        return (c != null && String.isNotBlank(c.TenantId__c)) ? c.TenantId__c : DEF_TENANT;
    }

    public static String agentId() {
        A365_Observability_Config__mdt c = getInstance();
        return (c != null && String.isNotBlank(c.AgentId__c)) ? c.AgentId__c : DEF_AGENT;
    }

    public static String ingestBase() {
        A365_Observability_Config__mdt c = getInstance();
        return (c != null && String.isNotBlank(c.IngestBase__c)) ? c.IngestBase__c : DEF_INGEST_BASE;
    }

    public static String obsScope() {
        A365_Observability_Config__mdt c = getInstance();
        return (c != null && String.isNotBlank(c.ObsScope__c)) ? c.ObsScope__c : DEF_OBS_SCOPE;
    }

    public static String fmiScope() {
        A365_Observability_Config__mdt c = getInstance();
        return (c != null && String.isNotBlank(c.FmiScope__c)) ? c.FmiScope__c : DEF_FMI_SCOPE;
    }

    public static String serviceName() {
        A365_Observability_Config__mdt c = getInstance();
        return (c != null && String.isNotBlank(c.ServiceName__c)) ? c.ServiceName__c : DEF_SERVICE_NAME;
    }

    // --- Origination (Agentforce-native) config ----------------------------------

    // service.name for Salesforce-ORIGINATED (Agentforce) traces — disambiguates this path
    // from the boundary emitter when both share the mapped agentId.
    public static String agentforceServiceName() {
        A365_Observability_Config__mdt c = getInstance();
        return (c != null && String.isNotBlank(c.AgentforceServiceName__c))
            ? c.AgentforceServiceName__c : DEF_AF_SERVICE_NAME;
    }

    // Master switch for the origination path, independent of the boundary Enabled__c.
    // Absent record/field => DISABLED (fail-safe: never originate without explicit opt-in).
    public static Boolean originateEnabled() {
        A365_Observability_Config__mdt c = getInstance();
        return c != null && c.OriginateEnabled__c == true;
    }

    public static Boolean useS2SEndpoint() {
        A365_Observability_Config__mdt c = getInstance();
        // Default to the S2S path (roles-enforced) when unspecified.
        return c == null || c.UseS2SEndpoint__c == true;
    }

    // The ingest path for the OTLP traces POST, honoring UseS2SEndpoint__c.
    public static String tracesPath() {
        String svc = useS2SEndpoint() ? 'observabilityService' : 'observability';
        return '/' + svc + '/tenants/' + tenantId()
            + '/otlp/agents/' + agentId() + '/traces?api-version=1';
    }
}