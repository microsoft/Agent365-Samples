// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// A365TelemetryQueueable — async worker that acquires the agent-bound token, builds the OTLP
// body, and POSTs the span to the Agent 365 ingest endpoint. Runs AFTER the caller's
// synchronous response, so it never affects Flow 1/Flow 2 latency or success.
//
// Best-effort by design: any failure (token, callout, non-2xx) is logged and swallowed.
// Implements Database.AllowsCallouts so the HTTP POST is permitted from the async context.
public with sharing class A365TelemetryQueueable implements Queueable, Database.AllowsCallouts {

    private final String traceId;
    private final String parentSpanId;
    private final String spanId;
    private final String spanName;
    private final String kind;
    private final String statusCode;
    private final Map<String, Object> attrs;
    private final Long startNs;
    private final Long endNs;
    private final String serviceName;

    private static final String NC_INGEST = 'A365_Obs_Ingest';

    // Boundary path (inbound traceparent) — uses the configured/default boundary service.name.
    public A365TelemetryQueueable(
        String traceId, String parentSpanId, String spanId,
        String spanName, String kind, String statusCode,
        Map<String, Object> attrs, Long startNs, Long endNs
    ) {
        this(traceId, parentSpanId, spanId, spanName, kind, statusCode,
             attrs, startNs, endNs, null);
    }

    // Origination path — carries an explicit service.name (blank/null => boundary config/default).
    public A365TelemetryQueueable(
        String traceId, String parentSpanId, String spanId,
        String spanName, String kind, String statusCode,
        Map<String, Object> attrs, Long startNs, Long endNs, String serviceName
    ) {
        this.traceId = traceId;
        this.parentSpanId = parentSpanId;
        this.spanId = spanId;
        this.spanName = spanName;
        this.kind = kind;
        this.statusCode = statusCode;
        this.attrs = attrs;
        this.startNs = startNs;
        this.endNs = endNs;
        this.serviceName = serviceName;
    }

    public void execute(QueueableContext context) {
        try {
            String tenantId = A365ObsConfig.tenantId();
            String agentId = A365ObsConfig.agentId();
            String token = A365ObsToken.getToken();
            String resolvedServiceName = String.isNotBlank(serviceName)
                ? serviceName
                : A365ObsConfig.serviceName();

            String body = A365ObsSpan.buildBody(
                tenantId, agentId, traceId, parentSpanId, spanId,
                spanName, kind, statusCode, attrs, startNs, endNs, resolvedServiceName);

            HttpRequest req = new HttpRequest();
            req.setEndpoint('callout:' + NC_INGEST + A365ObsConfig.tracesPath());
            req.setMethod('POST');
            req.setHeader('Content-Type', 'application/json');
            req.setHeader('Authorization', 'Bearer ' + token);
            req.setHeader('x-ms-tenant-id', tenantId);
            req.setTimeout(20000);
            req.setBody(body);

            HttpResponse res = new Http().send(req);
            Integer status = res.getStatusCode();
            if (status < 200 || status >= 300) {
                System.debug(LoggingLevel.WARN, 'A365Telemetry ingest non-2xx: HTTP '
                    + status + ' corr=' + res.getHeader('x-ms-correlation-id')
                    + ' body=' + res.getBody());
            } else {
                System.debug(LoggingLevel.INFO, 'A365Telemetry ingest ' + status
                    + ' spanId=' + spanId + ' traceId=' + traceId
                    + ' corr=' + res.getHeader('x-ms-correlation-id'));
            }
        } catch (Exception e) {
            // Best-effort: never rethrow from the async worker.
            System.debug(LoggingLevel.WARN, 'A365TelemetryQueueable swallowed: ' + e.getMessage());
        }
    }
}