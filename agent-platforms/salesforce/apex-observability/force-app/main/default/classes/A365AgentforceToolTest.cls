// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Unit tests for A365AgentforceTool — the in-band Agentforce action that originates
// an Agent 365 execute_tool span for a turn. Callouts (token + ingest) are mocked.
@IsTest
private class A365AgentforceToolTest {

    private static final String TENANT = '11111111-1111-1111-1111-111111111111';
    private static final String AGENT = '22222222-2222-2222-2222-222222222222';
    private static final String AF_SERVICE = 'salesforce-agentforce';
    private static final String SESSION = '44444444-4444-4444-4444-444444444444';

    private class MultiMock implements HttpCalloutMock {
        public Integer ingestCalls = 0;
        public List<String> ingestBodies = new List<String>();
        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setHeader('Content-Type', 'application/json');
            if (req.getEndpoint().contains('/oauth2/')) {
                res.setStatusCode(200);
                res.setBody('{"access_token":"FAKE","expires_in":3599}');
            } else {
                ingestCalls++;
                ingestBodies.add(req.getBody());
                res.setStatusCode(200);
                res.setHeader('x-ms-correlation-id', 'test-corr');
                res.setBody('{"partialSuccess":{"rejectedSpans":0}}');
            }
            return res;
        }
    }

    private static A365_Observability_Config__mdt cfg(Boolean originateEnabled) {
        return new A365_Observability_Config__mdt(
            Enabled__c = true,
            OriginateEnabled__c = originateEnabled,
            AgentforceServiceName__c = AF_SERVICE,
            TenantId__c = TENANT,
            AgentId__c = AGENT,
            IngestBase__c = 'https://agent365.svc.cloud.microsoft',
            ObsScope__c = 'api://9b975845-388f-4429-889e-eab1ef63949c/.default',
            FmiScope__c = 'api://AzureADTokenExchange/.default',
            UseS2SEndpoint__c = true,
            ServiceName__c = 'salesforce-apex');
    }

    private static A365AgentforceTool.Request req(String prompt, String sessionId) {
        A365AgentforceTool.Request r = new A365AgentforceTool.Request();
        r.prompt = prompt;
        r.sessionId = sessionId;
        return r;
    }

    private static Map<String, Object> firstSpan(String body) {
        Map<String, Object> root = (Map<String, Object>) JSON.deserializeUntyped(body);
        Map<String, Object> rs = (Map<String, Object>) ((List<Object>) root.get('resourceSpans'))[0];
        Map<String, Object> ss = (Map<String, Object>) ((List<Object>) rs.get('scopeSpans'))[0];
        return (Map<String, Object>) ((List<Object>) ss.get('spans'))[0];
    }

    @IsTest
    static void run_withSessionId_echoesAndOriginatesSeededTrace() {
        A365ObsConfig.overrideRecord = cfg(true);
        A365ObsToken.clearCache();
        MultiMock mock = new MultiMock();
        Test.setMock(HttpCalloutMock.class, mock);

        Test.startTest();
        List<A365AgentforceTool.Response> out =
            A365AgentforceTool.run(new List<A365AgentforceTool.Request>{
                req('hi there', SESSION) });
        Test.stopTest();

        System.assertEquals(1, out.size(), 'one response per request');
        System.assert(out[0].reply.contains('you said "hi there"'), 'echoes the prompt: ' + out[0].reply);
        System.assert(out[0].reply.contains('sessionId received'), 'reports in-band seeding');

        // Origination used the SessionId as the trace seed (invoke_agent root + execute_tool child).
        String expectedTrace = A365Trace.traceIdFromSeed(SESSION);
        System.assert(mock.ingestCalls >= 1, 'at least one span POSTed');
        Boolean sawExecuteTool = false;
        for (String body : mock.ingestBodies) {
            Map<String, Object> sp = firstSpan(body);
            System.assertEquals(expectedTrace, (String) sp.get('traceId'),
                'span uses the SessionId-seeded traceId');
            Map<String, Object> attrs = (Map<String, Object>) sp.get('attributes');
            if (attrs.get('gen_ai.operation.name') == 'execute_tool') {
                sawExecuteTool = true;
                System.assertEquals('A365AgentforceTool', attrs.get('gen_ai.tool.name'), 'tool name');
                System.assertEquals('input.sessionId', attrs.get('sf.seed.source'), 'seed source attr');
                System.assertEquals(A365Trace.spanIdFromSeed(SESSION), (String) sp.get('parentSpanId'),
                    'child nests under the seed-derived root');
            }
        }
        System.assert(sawExecuteTool, 'an execute_tool span was originated');
    }

    @IsTest
    static void run_withoutSessionId_usesFallbackButStillOriginates() {
        A365ObsConfig.overrideRecord = cfg(true);
        A365ObsToken.clearCache();
        MultiMock mock = new MultiMock();
        Test.setMock(HttpCalloutMock.class, mock);

        Test.startTest();
        List<A365AgentforceTool.Response> out =
            A365AgentforceTool.run(new List<A365AgentforceTool.Request>{
                req('no session', null) });
        Test.stopTest();

        System.assert(out[0].reply.contains('no sessionId in input'), 'reports fallback: ' + out[0].reply);
        System.assert(mock.ingestCalls >= 1, 'fallback seed still originates a trace');
        Boolean sawFallbackSource = false;
        for (String body : mock.ingestBodies) {
            Map<String, Object> attrs = (Map<String, Object>) firstSpan(body).get('attributes');
            if (attrs.get('gen_ai.operation.name') == 'execute_tool') {
                System.assertEquals('fallback', attrs.get('sf.seed.source'), 'seed source = fallback');
                sawFallbackSource = true;
            }
        }
        System.assert(sawFallbackSource, 'execute_tool span emitted with fallback seed');
    }

    @IsTest
    static void run_originationDisabled_stillRepliesNoCallout() {
        A365ObsConfig.overrideRecord = cfg(false); // OriginateEnabled__c = false
        MultiMock mock = new MultiMock();
        Test.setMock(HttpCalloutMock.class, mock);

        Test.startTest();
        List<A365AgentforceTool.Response> out =
            A365AgentforceTool.run(new List<A365AgentforceTool.Request>{
                req('hello', SESSION) });
        Test.stopTest();

        System.assertEquals(1, out.size(), 'still returns a reply when telemetry is off');
        System.assert(out[0].reply.contains('you said "hello"'), 'echo unaffected by telemetry gate');
        System.assertEquals(0, mock.ingestCalls, 'disabled origination => no callout');
    }

    @IsTest
    static void run_nullAndEmpty_handledGracefully() {
        A365ObsConfig.overrideRecord = cfg(true);
        Test.setMock(HttpCalloutMock.class, new MultiMock());

        Test.startTest();
        System.assertEquals(0, A365AgentforceTool.run(null).size(), 'null input => empty');
        List<A365AgentforceTool.Response> out =
            A365AgentforceTool.run(new List<A365AgentforceTool.Request>{
                req(null, null) });
        Test.stopTest();

        System.assertEquals(1, out.size(), 'null prompt still yields a reply');
        System.assert(out[0].reply.contains('hello'), 'blank prompt => greeting');
    }
}