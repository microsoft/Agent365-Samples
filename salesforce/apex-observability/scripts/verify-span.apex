// Smoke test: emit a single Agent 365 SERVER span via the public A365Telemetry façade and
// confirm the full pipeline (FMI 3-hop token -> OTLP ingest) end to end.
//
// Prerequisites (see ../README.md):
//   - core deployed; A365_Observability_Config.Default seeded (Enabled__c = true)
//   - BlueprintBasicAuth secret entered on the A365_Obs_Entra External Credential
//   - the A365_Observability permission set assigned to the running user
//
// Run, then tail the logs to see the async ingest result:
//   sf apex run      --file scripts/verify-span.apex --target-org <<ORG_ALIAS>>
//   sf apex tail log --target-org <<ORG_ALIAS>>
//
// A synthetic-but-valid W3C traceparent (00-<32 hex>-<16 hex>-01). In a real turn this comes
// from the inbound agent request header; here we fabricate one purely to exercise the pipeline.
String traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
Long nowNs = System.now().getTime() * 1000000L;

A365Telemetry.emitToolSpan(
    traceparent,
    'execute_tool verify-span',
    'SERVER',
    new Map<String, Object>{
        'gen_ai.operation.name' => 'execute_tool',
        'gen_ai.tool.name' => 'verify-span',
        'gen_ai.tool.type' => 'salesforce-apex',
        'sf.org.id' => UserInfo.getOrganizationId()
    },
    nowNs,
    nowNs + 1000000L,
    true);

System.debug('verify-span enqueued — tail the log for the async ingest HTTP status.');
