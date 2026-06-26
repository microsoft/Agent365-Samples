// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// A365ToolRest — Apex REST endpoint exposing Apex as an Agent 365 tool surface.
//
// Exposed automatically at:
//   POST {MyDomain}/services/apexrest/a365tool
//
// Contract (matches the A365 salesforceTool):
//   Request : { "prompt": "<text>" }
//   Response: { "reply": "<text>", "echo": "<prompt>", "source": "apex", "traceparent": "<echoed>" }
//
// A365Callout performs the reverse direction: an outbound POST from Apex into A365 /callback.

@RestResource(urlMapping='/a365tool/*')
global with sharing class A365ToolRest {

    // Incoming JSON body from A365.
    global class A365Request {
        global String prompt;
    }

    // Outgoing JSON body back to A365.
    global class A365Response {
        global String reply;
        global String echo;
        global String source;
        // Echo the inbound W3C trace context so the Apex leg is visibly
        // correlated with the A365 agent trace (same traceId on both sides).
        global String traceparent;
    }

    @HttpPost
    global static A365Response doPost() {
        Long startNs = System.now().getTime() * 1000000L;
        RestRequest req = RestContext.request;
        String rawBody = (req != null && req.requestBody != null) ? req.requestBody.toString() : '';

        // Read the inbound W3C trace context. Header names are lowercase per
        // the W3C Trace Context spec; match case-insensitively to be safe.
        String traceparent = getHeaderIgnoreCase(req, 'traceparent');
        String tracestate = getHeaderIgnoreCase(req, 'tracestate');
        if (String.isNotBlank(traceparent)) {
            System.debug('A365 trace context received: traceparent=' + traceparent +
                (String.isNotBlank(tracestate) ? ' tracestate=' + tracestate : ''));
        }

        String prompt = '';
        if (String.isNotBlank(rawBody)) {
            try {
                A365Request parsed = (A365Request) JSON.deserialize(rawBody, A365Request.class);
                if (parsed != null && parsed.prompt != null) {
                    prompt = parsed.prompt;
                }
            } catch (Exception e) {
                // Treat an unparseable body as an empty prompt.
            }
        }

        A365Response res = new A365Response();
        res.echo = prompt;
        res.source = 'apex';
        res.traceparent = traceparent;
        res.reply = String.isBlank(prompt)
            ? 'Hello from Salesforce Apex! (no prompt received)'
            : 'Hello from Salesforce Apex! You said: "' + prompt + '"';

        // Native Apex observability: emit this tool execution as its own A365 OTLP span,
        // correlated to the agent turn via the inbound traceparent. Fail-open + async, so
        // the synchronous reply above is never slowed or broken. No traceparent => no-op.
        A365Telemetry.emitToolSpan(
            traceparent, 'execute_tool A365ToolRest', 'SERVER',
            new Map<String, Object>{
                'gen_ai.operation.name' => 'execute_tool',
                'gen_ai.tool.name' => 'A365ToolRest',
                'gen_ai.tool.type' => 'salesforce-apex',
                'sf.org.id' => UserInfo.getOrganizationId(),
                'sf.prompt.len' => (prompt == null ? 0 : prompt.length())
            },
            startNs, System.now().getTime() * 1000000L, true);

        return res;
    }

    // Returns the named header from the REST request, matching case-insensitively.
    private static String getHeaderIgnoreCase(RestRequest req, String name) {
        if (req == null || req.headers == null) {
            return null;
        }
        for (String key : req.headers.keySet()) {
            if (key != null && key.equalsIgnoreCase(name)) {
                return req.headers.get(key);
            }
        }
        return null;
    }

    // Convenience GET so you can sanity-check the endpoint quickly.
    @HttpGet
    global static A365Response doGet() {
        A365Response res = new A365Response();
        res.source = 'apex';
        res.reply = 'A365ToolRest is alive. POST { "prompt": "..." } to talk to it.';
        return res;
    }
}