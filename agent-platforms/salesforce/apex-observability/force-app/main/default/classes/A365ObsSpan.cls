// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// A365ObsSpan — builds the Agent 365 OTLP span JSON body.
//
// IMPORTANT: this mirrors the Agent 365 OTLP wire shape the A365 ingest accepts today
// (the ground truth), NOT hand-rolled "standard OTLP":
//   - `attributes` is a flat object MAP (not an array of {key,value}).
//   - `kind` and `status.code` are enum STRINGS (not integers).
//   - `*UnixNano` are JSON NUMBERS.
//   - resource key is `microsoft.tenant.id`; the request header is `x-ms-tenant-id`.
// If the ingest ever returns 400 on this shape, the documented fallback is standard
// OTLP (array-of-keyvalue, integer enums) — see docs/design.md -> "OTLP wire shape".
//
// Pure (no callouts) so it is trivially unit-testable.
public with sharing class A365ObsSpan {

    // Default constants — overridden by the A365_Observability_Config__mdt 'Default' record.
    @TestVisible private static final String SERVICE_NAME = 'salesforce-apex';
    @TestVisible private static final String SCOPE_NAME = 'salesforce-apex';
    @TestVisible private static final String SCOPE_VERSION = '0.1.0';
    @TestVisible private static final String SDK_NAME = 'A365ObservabilitySDK-Apex';
    @TestVisible private static final String SDK_LANGUAGE = 'apex';

    // Build the OTLP body for a single span.
    //  tenantId/agentId : routing + auth keys (also surfaced as attributes).
    //  traceId          : 32-hex from the inbound traceparent — NEVER regenerated.
    //  parentSpanId     : 16-hex from the inbound traceparent (null => omitted, root span).
    //  spanId           : 16-hex freshly minted for this span.
    //  name             : span name, e.g. 'execute_tool A365ToolRest'.
    //  kind             : INTERNAL|SERVER|CLIENT|PRODUCER|CONSUMER|UNSPECIFIED.
    //  statusCode       : UNSET|OK|ERROR.
    //  attrs            : extra span attributes (flat map). gen_ai.agent.id is added if absent.
    public static String buildBody(
        String tenantId, String agentId, String traceId, String parentSpanId, String spanId,
        String name, String kind, String statusCode, Map<String, Object> attrs
    ) {
        // Convenience overload: distinct start/end timestamps (now .. now+1ms) in nanoseconds.
        Long startNs = System.now().getTime() * 1000000L;
        Long endNs = startNs + 1000000L;
        return buildBody(tenantId, agentId, traceId, parentSpanId, spanId, name, kind,
                         statusCode, attrs, startNs, endNs);
    }

    // Full overload with caller-supplied nanosecond timestamps (used by the productionized
    // emitter so the span reflects real Apex execution timing).
    public static String buildBody(
        String tenantId, String agentId, String traceId, String parentSpanId, String spanId,
        String name, String kind, String statusCode, Map<String, Object> attrs,
        Long startNs, Long endNs
    ) {
        return buildBody(tenantId, agentId, traceId, parentSpanId, spanId, name, kind,
                         statusCode, attrs, startNs, endNs, null);
    }

    // Overload allowing the resource `service.name` to be overridden per path. The
    // origination (Agentforce) path passes A365ObsConfig.agentforceServiceName() so its
    // traces are distinguishable from the boundary emitter under a shared agentId.
    // serviceName blank/null => the default boundary SERVICE_NAME (unchanged behavior).
    public static String buildBody(
        String tenantId, String agentId, String traceId, String parentSpanId, String spanId,
        String name, String kind, String statusCode, Map<String, Object> attrs,
        Long startNs, Long endNs, String serviceName
    ) {
        String svcName = String.isNotBlank(serviceName) ? serviceName : SERVICE_NAME;
        Map<String, Object> resourceAttrs = new Map<String, Object>{
            'service.name' => svcName,
            'microsoft.tenant.id' => tenantId,
            'gen_ai.agent.id' => agentId,
            'telemetry.sdk.name' => SDK_NAME,
            'telemetry.sdk.language' => SDK_LANGUAGE
        };

        Map<String, Object> spanAttrs = new Map<String, Object>();
        if (attrs != null) {
            spanAttrs.putAll(attrs);
        }
        // gen_ai.agent.id must appear on the span too (routing/identity, not just a label).
        if (!spanAttrs.containsKey('gen_ai.agent.id')) {
            spanAttrs.put('gen_ai.agent.id', agentId);
        }

        Map<String, Object> span = new Map<String, Object>{
            'traceId' => traceId,
            'spanId' => spanId,
            'name' => name,
            'kind' => kind,
            'startTimeUnixNano' => startNs,
            'endTimeUnixNano' => endNs,
            'attributes' => spanAttrs,
            'status' => new Map<String, Object>{
                'code' => statusCode,
                'message' => ''
            }
        };
        // Omit parentSpanId entirely when absent (root span) rather than send null/empty.
        if (String.isNotBlank(parentSpanId)) {
            span.put('parentSpanId', parentSpanId);
        }

        Map<String, Object> resourceSpan = new Map<String, Object>{
            'resource' => new Map<String, Object>{ 'attributes' => resourceAttrs },
            'scopeSpans' => new List<Object>{
                new Map<String, Object>{
                    'scope' => new Map<String, Object>{
                        'name' => SCOPE_NAME,
                        'version' => SCOPE_VERSION
                    },
                    'spans' => new List<Object>{ span }
                }
            }
        };

        Map<String, Object> root = new Map<String, Object>{
            'resourceSpans' => new List<Object>{ resourceSpan }
        };

        // suppressApexObjectNulls = true: keeps the body clean if any value is null.
        return JSON.serialize(root, true);
    }
}