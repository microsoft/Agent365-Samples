// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// A365Callout — Salesforce -> A365 outbound HTTP callout.
//
// Performs an outbound POST from Apex into the A365 /callback endpoint.
// The endpoint is referenced via a Named Credential so the URL lives in one
// place (Setup -> Named Credentials -> "A365_Callback") and no Remote Site
// Setting is required. See README for the one-time Named Credential setup.
//
// Trigger it any of these ways:
//   - Execute Anonymous:  System.debug(A365Callout.callA365('hello from apex'));
//   - From Agentforce/Flow via the @InvocableMethod below
//   - From another Apex class / REST resource

public with sharing class A365Callout {

    public class CalloutInput {
        @InvocableVariable(label='Message' description='Text to send to A365' required=true)
        public String message;
        @InvocableVariable(label='Traceparent' description='Optional W3C traceparent to correlate this callback into an existing A365 trace')
        public String traceparent;
    }

    public class CalloutResult {
        @InvocableVariable(label='Status Code')
        public Integer statusCode;
        @InvocableVariable(label='Response Body')
        public String responseBody;
    }

    @InvocableMethod(label='Call A365 Callback' description='POSTs a message to the A365 /callback endpoint and returns the response.')
    public static List<CalloutResult> callFromFlow(List<CalloutInput> inputs) {
        List<CalloutResult> results = new List<CalloutResult>();
        for (CalloutInput input : inputs) {
            results.add(callA365(
                input != null ? input.message : '',
                input != null ? input.traceparent : null
            ));
        }
        return results;
    }

    // Core HTTP callout into A365. Uses Named Credential 'A365_Callback'.
    public static CalloutResult callA365(String message) {
        return callA365(message, null);
    }

    // Overload that forwards a W3C trace context so the Salesforce -> A365
    // callback leg continues an existing trace instead of starting an unrelated one.
    public static CalloutResult callA365(String message, String traceparent) {
        Long startNs = System.now().getTime() * 1000000L;
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:A365_Callback/callback');
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        if (String.isNotBlank(traceparent)) {
            req.setHeader('traceparent', traceparent);
        }
        req.setTimeout(20000);

        Map<String, Object> payload = new Map<String, Object>{
            'source'  => 'salesforce-apex',
            'orgId'   => UserInfo.getOrganizationId(),
            'user'    => UserInfo.getUserName(),
            'message' => message
        };
        req.setBody(JSON.serialize(payload));

        CalloutResult result = new CalloutResult();
        try {
            HttpResponse res = new Http().send(req);
            result.statusCode = res.getStatusCode();
            result.responseBody = res.getBody();
        } catch (Exception e) {
            result.statusCode = -1;
            result.responseBody = 'Callout failed: ' + e.getMessage();
        }

        // Native Apex observability: emit a CLIENT span for this outbound A365 callback leg,
        // reusing the forwarded traceparent so it nests in the same agent trace. Fail-open +
        // async; no-op when traceparent is blank (never fabricate a trace).
        Boolean ok = result.statusCode != null && result.statusCode >= 200 && result.statusCode < 300;
        A365Telemetry.emitToolSpan(
            traceparent, 'execute_tool A365Callout', 'CLIENT',
            new Map<String, Object>{
                'gen_ai.operation.name' => 'execute_tool',
                'gen_ai.tool.name' => 'A365Callout',
                'gen_ai.tool.type' => 'salesforce-apex',
                'sf.org.id' => UserInfo.getOrganizationId(),
                'http.response.status_code' => result.statusCode
            },
            startNs, System.now().getTime() * 1000000L, ok);

        return result;
    }
}