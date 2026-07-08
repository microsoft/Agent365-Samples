// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// A365Telemetry — public façade for emitting a Salesforce-originated Agent 365 OTLP span.
//
// This is the ONLY entry point the business code (A365ToolRest, A365Callout) calls. It is
// deliberately tiny and **fail-open**: it must never slow or break Flow 1/Flow 2. The actual
// token dance + HTTP POST happen asynchronously in A365TelemetryQueueable, after the caller's
// synchronous response has already been returned.
//
// Behavior:
//   - gated on A365_Observability_Config__mdt.Enabled__c (master kill-switch) -> no-op when off;
//   - requires a valid inbound `traceparent` -> NEVER fabricates a trace (no traceparent = no-op),
//     so a Salesforce span only ever exists correlated to a real agent turn;
//   - the whole method is wrapped in try/catch: any failure is swallowed (debug-logged only).
public with sharing class A365Telemetry {

    // Emit one execute_tool span for the current Apex unit of work.
    //  traceparent : inbound W3C header from the agent turn (reused, never regenerated).
    //  spanName    : e.g. 'execute_tool A365ToolRest'.
    //  kind        : OTLP span kind string (SERVER for inbound REST, CLIENT for outbound callout).
    //  attrs       : flat span attributes (gen_ai.operation.name, tool name/type, etc.).
    //  startNs/endNs : Apex execution window in nanoseconds (epoch-based).
    //  ok          : true => status OK, false => status ERROR.
    public static void emitToolSpan(
        String traceparent, String spanName, String kind,
        Map<String, Object> attrs, Long startNs, Long endNs, Boolean ok
    ) {
        try {
            if (!A365ObsConfig.isEnabled()) {
                return; // master kill-switch off => no-op.
            }

            A365Trace.TraceContext ctx = A365Trace.parseTraceparent(traceparent);
            if (ctx == null) {
                return; // no/invalid traceparent => no-op (never fabricate a trace).
            }

            Map<String, Object> spanAttrs = (attrs != null)
                ? new Map<String, Object>(attrs)
                : new Map<String, Object>();
            String statusCode = (ok == true) ? 'OK' : 'ERROR';

            System.enqueueJob(new A365TelemetryQueueable(
                ctx.traceId, ctx.parentSpanId, A365Trace.newSpanId(),
                spanName, kind, statusCode, spanAttrs, startNs, endNs));
        } catch (Exception e) {
            // Fail-open: telemetry must never affect the caller's flow.
            System.debug(LoggingLevel.WARN, 'A365Telemetry.emitToolSpan swallowed: ' + e.getMessage());
        }
    }

    // ============================ Origination (Agentforce-native) ============================
    //
    // Unlike emitToolSpan (which reuses an inbound traceparent and NEVER fabricates a trace),
    // these methods make SALESFORCE the trace ORIGINATOR. There is no inbound traceparent for
    // an Agentforce turn, so the traceId + root `invoke_agent` span id are derived
    // deterministically from the Agentforce session id (A365Trace.*FromSeed). Every span of a
    // session therefore shares one trace and nests under one reconstructable root, even when
    // emitted from independent Apex transactions (each action) — no shared state.
    //
    // Gated on A365ObsConfig.originateEnabled() (independent of the boundary Enabled__c) and
    // fully fail-open + async (Queueable), so it never affects an Agentforce turn.

    // Per-transaction dedup so a session's `invoke_agent` root is emitted at most once (L1).
    @TestVisible private static Set<String> rootsEmittedThisTxn = new Set<String>();

    private static final String CACHE_PARTITION = 'local.A365Obs';
    private static final Integer ROOT_DEDUP_TTL_SECONDS = 3600;

    // Emit the session's root `invoke_agent` span (deduped). Optional: most callers only need
    // originateToolSpan, which synthesizes a default root automatically.
    public static void originateAgentTurn(
        String seed, String spanName, Map<String, Object> attrs,
        Long startNs, Long endNs, Boolean ok
    ) {
        try {
            if (!A365ObsConfig.originateEnabled() || String.isBlank(seed)) {
                return; // disabled or no seed => no-op (cannot originate without a seed).
            }
            emitRoot(seed, spanName, attrs, startNs, endNs, ok);
        } catch (Exception e) {
            System.debug(LoggingLevel.WARN, 'A365Telemetry.originateAgentTurn swallowed: ' + e.getMessage());
        }
    }

    // Emit a child `execute_tool` span nested under the session's `invoke_agent` root. Ensures
    // the root exists first (deduped), so a single action call yields a complete 2-span trace.
    public static void originateToolSpan(
        String seed, String spanName, Map<String, Object> attrs,
        Long startNs, Long endNs, Boolean ok
    ) {
        try {
            if (!A365ObsConfig.originateEnabled() || String.isBlank(seed)) {
                return;
            }
            ensureRoot(seed, startNs);

            String traceId = A365Trace.traceIdFromSeed(seed);
            String rootSpanId = A365Trace.spanIdFromSeed(seed);
            Map<String, Object> spanAttrs = (attrs != null)
                ? new Map<String, Object>(attrs) : new Map<String, Object>();
            String statusCode = (ok == true) ? 'OK' : 'ERROR';

            enqueueOriginated(traceId, rootSpanId, A365Trace.newSpanId(),
                spanName, 'SERVER', statusCode, spanAttrs, startNs, endNs);
        } catch (Exception e) {
            System.debug(LoggingLevel.WARN, 'A365Telemetry.originateToolSpan swallowed: ' + e.getMessage());
        }
    }

    // Emit the `invoke_agent` root for a seed exactly once (L1 txn set + L2 Platform Cache).
    private static void emitRoot(
        String seed, String spanName, Map<String, Object> attrs,
        Long startNs, Long endNs, Boolean ok
    ) {
        if (!claimRoot(seed)) {
            return; // already emitted for this seed (dedup).
        }
        String traceId = A365Trace.traceIdFromSeed(seed);
        String rootSpanId = A365Trace.spanIdFromSeed(seed);
        Map<String, Object> spanAttrs = (attrs != null)
            ? new Map<String, Object>(attrs) : new Map<String, Object>();
        if (!spanAttrs.containsKey('gen_ai.operation.name')) {
            spanAttrs.put('gen_ai.operation.name', 'invoke_agent');
        }
        String statusCode = (ok == true) ? 'OK' : 'ERROR';
        // Root span: no parent (parentSpanId = null) — it is the top of the Agentforce trace.
        enqueueOriginated(traceId, null, rootSpanId,
            spanName, 'SERVER', statusCode, spanAttrs, startNs, endNs);
    }

    // Synthesize a default `invoke_agent` root when a tool span originates without an explicit
    // originateAgentTurn (the common in-band case where only the action emits).
    private static void ensureRoot(String seed, Long refStartNs) {
        Long s = (refStartNs != null) ? refStartNs : (System.now().getTime() * 1000000L);
        emitRoot(seed,
            'invoke_agent ' + A365ObsConfig.agentforceServiceName(),
            new Map<String, Object>{ 'gen_ai.operation.name' => 'invoke_agent' },
            s, s + 1000000L, true);
    }

    // True if THIS caller should emit the root (not yet emitted for the seed). L1 = a
    // per-transaction Set; L2 = Platform Cache (best-effort, extends dedup across
    // transactions). Cache keys must be alphanumeric, so the seed is hashed into the key.
    private static Boolean claimRoot(String seed) {
        if (rootsEmittedThisTxn.contains(seed)) {
            return false;
        }
        String key = 'obsRoot' + EncodingUtil.convertToHex(
            Crypto.generateDigest('SHA-256', Blob.valueOf(seed))).substring(0, 24);
        try {
            Cache.OrgPartition partition = Cache.Org.getPartition(CACHE_PARTITION);
            if (partition != null) {
                if (partition.contains(key)) {
                    rootsEmittedThisTxn.add(seed);
                    return false;
                }
                partition.put(key, true, ROOT_DEDUP_TTL_SECONDS);
            }
        } catch (Exception e) {
            // Platform Cache unavailable — degrade to per-transaction (L1) dedup only.
        }
        rootsEmittedThisTxn.add(seed);
        return true;
    }

    private static void enqueueOriginated(
        String traceId, String parentSpanId, String spanId,
        String spanName, String kind, String statusCode,
        Map<String, Object> attrs, Long startNs, Long endNs
    ) {
        System.enqueueJob(new A365TelemetryQueueable(
            traceId, parentSpanId, spanId, spanName, kind, statusCode,
            attrs, startNs, endNs, A365ObsConfig.agentforceServiceName()));
    }
}