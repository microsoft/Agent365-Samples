// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Unit tests for the Agentforce-native ORIGINATION path: A365Telemetry.originate* +
// deterministic seeding + root dedup + service.name + fail-open. All callouts mocked.
// The boundary emitToolSpan ("never fabricate a trace") path is covered by A365TelemetryTest.
@IsTest
private class A365TelemetryOriginateTest {

    private static final String TENANT = '11111111-1111-1111-1111-111111111111';
    private static final String AGENT = '22222222-2222-2222-2222-222222222222';
    private static final String AF_SERVICE = 'salesforce-agentforce';
    private static final String SEED = 'sample-session-0001';

    // Routes by endpoint: /oauth2/ => fake tokens; /otlp/ => configurable status. Collects
    // EVERY ingest body so tests can assert per-span (invoke_agent vs execute_tool) shape.
    private class MultiMock implements HttpCalloutMock {
        public Integer tokenCalls = 0;
        public Integer ingestCalls = 0;
        public Integer ingestStatus = 200;
        public List<String> ingestBodies = new List<String>();

        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setHeader('Content-Type', 'application/json');
            if (req.getEndpoint().contains('/oauth2/')) {
                tokenCalls++;
                res.setStatusCode(200);
                String tok = (Math.mod(tokenCalls, 2) == 1) ? 'FAKE_T1' : 'FAKE_OBS_TOKEN';
                res.setBody('{"access_token":"' + tok + '","expires_in":3599}');
            } else {
                ingestCalls++;
                ingestBodies.add(req.getBody());
                res.setStatusCode(ingestStatus);
                res.setHeader('x-ms-correlation-id', 'test-corr');
                res.setBody('{"partialSuccess":{"rejectedSpans":0}}');
            }
            return res;
        }
    }

    private static A365_Observability_Config__mdt cfg(Boolean originateEnabled) {
        return cfg(originateEnabled, null, null);
    }

    // Overload with Admin Center attribution/enrichment fields (Option 1 + 3).
    private static A365_Observability_Config__mdt cfg(
        Boolean originateEnabled, String runAsUserId, String blueprintId
    ) {
        return new A365_Observability_Config__mdt(
            Enabled__c = true,
            OriginateEnabled__c = originateEnabled,
            AgentforceServiceName__c = AF_SERVICE,
            RunAsUserId__c = runAsUserId,
            BlueprintId__c = blueprintId,
            TenantId__c = TENANT,
            AgentId__c = AGENT,
            IngestBase__c = 'https://agent365.svc.cloud.microsoft',
            ObsScope__c = 'api://9b975845-388f-4429-889e-eab1ef63949c/.default',
            FmiScope__c = 'api://AzureADTokenExchange/.default',
            UseS2SEndpoint__c = true,
            ServiceName__c = 'salesforce-apex');
    }

    // ---- body parsing helpers ----
    private static Map<String, Object> span(String body) {
        Map<String, Object> root = (Map<String, Object>) JSON.deserializeUntyped(body);
        Map<String, Object> rs = (Map<String, Object>) ((List<Object>) root.get('resourceSpans'))[0];
        Map<String, Object> ss = (Map<String, Object>) ((List<Object>) rs.get('scopeSpans'))[0];
        return (Map<String, Object>) ((List<Object>) ss.get('spans'))[0];
    }

    private static String serviceName(String body) {
        Map<String, Object> root = (Map<String, Object>) JSON.deserializeUntyped(body);
        Map<String, Object> rs = (Map<String, Object>) ((List<Object>) root.get('resourceSpans'))[0];
        Map<String, Object> resource = (Map<String, Object>) rs.get('resource');
        Map<String, Object> ra = (Map<String, Object>) resource.get('attributes');
        return (String) ra.get('service.name');
    }

    private static String opName(Map<String, Object> sp) {
        Map<String, Object> attrs = (Map<String, Object>) sp.get('attributes');
        return (String) attrs.get('gen_ai.operation.name');
    }

    private static Object attr(Map<String, Object> sp, String key) {
        return ((Map<String, Object>) sp.get('attributes')).get(key);
    }

    // Returns the invoke_agent root span body from a batch of ingest bodies.
    private static Map<String, Object> rootSpan(List<String> bodies) {
        for (String body : bodies) {
            Map<String, Object> sp = span(body);
            if (opName(sp) == 'invoke_agent') { return sp; }
        }
        return null;
    }

    @IsTest
    static void originateToolSpan_emitsRootAndChildWithDeterministicSeeding() {
        A365ObsConfig.overrideRecord = cfg(true);
        A365ObsToken.clearCache();
        MultiMock mock = new MultiMock();
        Test.setMock(HttpCalloutMock.class, mock);

        Long t0 = 1750000000000000000L;
        Test.startTest();
        A365Telemetry.originateToolSpan(SEED, 'execute_tool A365AgentforceTool',
            new Map<String, Object>{ 'gen_ai.operation.name' => 'execute_tool',
                                     'gen_ai.tool.type' => 'salesforce-apex' },
            t0, t0 + 3000000L, true);
        Test.stopTest();

        String expectedTrace = A365Trace.traceIdFromSeed(SEED);
        String expectedRoot = A365Trace.spanIdFromSeed(SEED);

        System.assertEquals(2, mock.ingestCalls, 'one root + one child POSTed');
        Integer invokeAgent = 0, executeTool = 0;
        for (String body : mock.ingestBodies) {
            Map<String, Object> sp = span(body);
            System.assertEquals(expectedTrace, (String) sp.get('traceId'),
                'every span shares the seed-derived traceId');
            System.assertEquals(AF_SERVICE, serviceName(body), 'origination service.name');
            String op = opName(sp);
            if (op == 'invoke_agent') {
                invokeAgent++;
                System.assertEquals(expectedRoot, (String) sp.get('spanId'),
                    'root spanId == spanIdFromSeed');
                System.assert(!sp.containsKey('parentSpanId'), 'root has no parent');
            } else if (op == 'execute_tool') {
                executeTool++;
                System.assertEquals(expectedRoot, (String) sp.get('parentSpanId'),
                    'child nests under the seed-derived root');
            }
        }
        System.assertEquals(1, invokeAgent, 'exactly one invoke_agent root');
        System.assertEquals(1, executeTool, 'exactly one execute_tool child');
    }

    @IsTest
    static void originateToolSpan_dedupesRootAcrossCallsSameSeed() {
        A365ObsConfig.overrideRecord = cfg(true);
        A365ObsToken.clearCache();
        MultiMock mock = new MultiMock();
        Test.setMock(HttpCalloutMock.class, mock);

        Long t0 = 1750000000000000000L;
        Test.startTest();
        A365Telemetry.originateToolSpan(SEED, 'execute_tool A',
            new Map<String, Object>{ 'gen_ai.operation.name' => 'execute_tool' }, t0, t0 + 1L, true);
        A365Telemetry.originateToolSpan(SEED, 'execute_tool B',
            new Map<String, Object>{ 'gen_ai.operation.name' => 'execute_tool' }, t0, t0 + 1L, true);
        Test.stopTest();

        Integer invokeAgent = 0, executeTool = 0;
        for (String body : mock.ingestBodies) {
            String op = opName(span(body));
            if (op == 'invoke_agent') { invokeAgent++; }
            else if (op == 'execute_tool') { executeTool++; }
        }
        System.assertEquals(1, invokeAgent, 'invoke_agent root emitted ONCE per seed (dedup)');
        System.assertEquals(2, executeTool, 'both execute_tool children emitted');
    }

    @IsTest
    static void originateAgentTurn_thenToolSpan_shareOneRoot() {
        A365ObsConfig.overrideRecord = cfg(true);
        A365ObsToken.clearCache();
        MultiMock mock = new MultiMock();
        Test.setMock(HttpCalloutMock.class, mock);

        Long t0 = 1750000000000000000L;
        Test.startTest();
        A365Telemetry.originateAgentTurn(SEED, 'invoke_agent A365 Agentforce',
            new Map<String, Object>{ 'gen_ai.operation.name' => 'invoke_agent' }, t0, t0 + 5000000L, true);
        A365Telemetry.originateToolSpan(SEED, 'execute_tool A365AgentforceTool',
            new Map<String, Object>{ 'gen_ai.operation.name' => 'execute_tool' }, t0 + 1L, t0 + 2L, true);
        Test.stopTest();

        Integer invokeAgent = 0;
        for (String body : mock.ingestBodies) {
            if (opName(span(body)) == 'invoke_agent') { invokeAgent++; }
        }
        System.assertEquals(1, invokeAgent, 'explicit root + tool span converge on one root');
        System.assertEquals(2, mock.ingestCalls, 'exactly two spans total');
    }

    @IsTest
    static void originate_setsAttributionAttrsOnRoot_whenConfigured() {
        String runAsUser = '33333333-3333-3333-3333-333333333333';
        String blueprint = '44444444-4444-4444-4444-444444444444';
        A365ObsConfig.overrideRecord = cfg(true, runAsUser, blueprint);
        A365ObsToken.clearCache();
        MultiMock mock = new MultiMock();
        Test.setMock(HttpCalloutMock.class, mock);

        Long t0 = 1750000000000000000L;
        Test.startTest();
        A365Telemetry.originateToolSpan(SEED, 'execute_tool A365AgentforceTool',
            new Map<String, Object>{ 'gen_ai.operation.name' => 'execute_tool' }, t0, t0 + 3000000L, true);
        Test.stopTest();

        Map<String, Object> root = rootSpan(mock.ingestBodies);
        System.assertNotEquals(null, root, 'root invoke_agent span emitted');
        System.assertEquals(runAsUser, attr(root, 'user.id'),
            'user.id (Admin Center UserKey) set from RunAsUserId__c');
        System.assertEquals(blueprint, attr(root, 'microsoft.a365.agent.blueprint.id'),
            'blueprint id enrichment set');
        System.assertEquals(AF_SERVICE, attr(root, 'gen_ai.agent.name'),
            'agent name falls back to the service name');
        System.assertEquals('agentforce', attr(root, 'microsoft.channel.name'),
            'channel name defaults to agentforce');
        System.assertEquals(SEED, attr(root, 'gen_ai.conversation.id'),
            'conversation id derives from the session seed');
        System.assertEquals(SEED, attr(root, 'microsoft.session.id'),
            'session id derives from the session seed');
    }

    @IsTest
    static void originate_omitsUserId_whenRunAsUserBlank() {
        A365ObsConfig.overrideRecord = cfg(true); // no run-as user configured
        A365ObsToken.clearCache();
        MultiMock mock = new MultiMock();
        Test.setMock(HttpCalloutMock.class, mock);

        Long t0 = 1750000000000000000L;
        Test.startTest();
        A365Telemetry.originateToolSpan(SEED, 'execute_tool A365AgentforceTool',
            new Map<String, Object>{ 'gen_ai.operation.name' => 'execute_tool' }, t0, t0 + 1L, true);
        Test.stopTest();

        Map<String, Object> root = rootSpan(mock.ingestBodies);
        System.assertNotEquals(null, root, 'root invoke_agent span still emitted');
        System.assert(!((Map<String, Object>) root.get('attributes')).containsKey('user.id'),
            'user.id omitted when RunAsUserId__c is blank (user-less, Defender-only)');
        System.assert(!((Map<String, Object>) root.get('attributes')).containsKey('microsoft.a365.agent.blueprint.id'),
            'blueprint id omitted when BlueprintId__c is blank');
    }

    @IsTest
    static void originate_disabled_isNoOp() {
        A365ObsConfig.overrideRecord = cfg(false); // OriginateEnabled__c = false
        MultiMock mock = new MultiMock();
        Test.setMock(HttpCalloutMock.class, mock);

        Test.startTest();
        A365Telemetry.originateToolSpan(SEED, 'execute_tool A',
            new Map<String, Object>{ 'gen_ai.operation.name' => 'execute_tool' }, 1L, 2L, true);
        A365Telemetry.originateAgentTurn(SEED, 'invoke_agent A', null, 1L, 2L, true);
        Test.stopTest();

        System.assertEquals(0, mock.tokenCalls, 'disabled => no token call');
        System.assertEquals(0, mock.ingestCalls, 'disabled => no ingest call');
    }

    @IsTest
    static void originate_blankSeed_isNoOp() {
        A365ObsConfig.overrideRecord = cfg(true);
        MultiMock mock = new MultiMock();
        Test.setMock(HttpCalloutMock.class, mock);

        Test.startTest();
        A365Telemetry.originateToolSpan(null, 'execute_tool A', null, 1L, 2L, true);
        A365Telemetry.originateToolSpan('', 'execute_tool A', null, 1L, 2L, true);
        Test.stopTest();

        System.assertEquals(0, mock.ingestCalls, 'no seed => never originate');
    }

    @IsTest
    static void originate_ingestFails_failsOpen() {
        A365ObsConfig.overrideRecord = cfg(true);
        A365ObsToken.clearCache();
        MultiMock mock = new MultiMock();
        mock.ingestStatus = 500;
        Test.setMock(HttpCalloutMock.class, mock);

        Test.startTest();
        // Must not throw even though ingest returns 500.
        A365Telemetry.originateToolSpan(SEED, 'execute_tool A',
            new Map<String, Object>{ 'gen_ai.operation.name' => 'execute_tool' }, 1L, 2L, false);
        Test.stopTest();

        System.assert(mock.ingestCalls >= 1, 'ingest attempted');
        System.assert(true, 'caller unaffected by ingest 500 (fail-open)');
    }

    @IsTest
    static void boundaryEmitToolSpan_stillNoOpsWithoutTraceparent() {
        // Regression: enabling origination must NOT change the boundary "never fabricate" rule.
        A365ObsConfig.overrideRecord = cfg(true);
        MultiMock mock = new MultiMock();
        Test.setMock(HttpCalloutMock.class, mock);

        Test.startTest();
        A365Telemetry.emitToolSpan(null, 'execute_tool A365ToolRest', 'SERVER', null, 1L, 2L, true);
        A365Telemetry.emitToolSpan('not-a-traceparent', 'execute_tool A365ToolRest', 'SERVER',
            null, 1L, 2L, true);
        Test.stopTest();

        System.assertEquals(0, mock.ingestCalls,
            'boundary path still no-ops without a valid inbound traceparent');
    }
}