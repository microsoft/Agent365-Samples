// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Unit tests for the emitter: A365Telemetry façade + A365TelemetryQueueable + the
// token cache in A365ObsToken. All callouts (token hops + ingest) are mocked.
@IsTest
private class A365TelemetryTest {

    private static final String TENANT = '11111111-1111-1111-1111-111111111111';
    private static final String AGENT = '22222222-2222-2222-2222-222222222222';
    private static final String TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
    private static final String PARENT = '00f067aa0ba902b7';
    private static final String TRACEPARENT = '00-' + TRACE + '-' + PARENT + '-01';

    // Routes by endpoint: token endpoints (/oauth2/) return fake tokens; ingest (/otlp/)
    // returns a configurable status. Records counts + the last ingest request for asserts.
    private class MultiMock implements HttpCalloutMock {
        public Integer tokenCalls = 0;
        public Integer ingestCalls = 0;
        public Integer ingestStatus = 200;
        public String lastIngestBody;
        public String lastAuthHeader;
        public String lastTenantHeader;

        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setHeader('Content-Type', 'application/json');
            if (req.getEndpoint().contains('/oauth2/')) {
                tokenCalls++;
                res.setStatusCode(200);
                String tok = (tokenCalls == 1) ? 'FAKE_T1' : 'FAKE_OBS_TOKEN';
                res.setBody('{"access_token":"' + tok + '","expires_in":3599}');
            } else {
                ingestCalls++;
                lastIngestBody = req.getBody();
                lastAuthHeader = req.getHeader('Authorization');
                lastTenantHeader = req.getHeader('x-ms-tenant-id');
                res.setStatusCode(ingestStatus);
                res.setHeader('x-ms-correlation-id', 'test-corr');
                res.setBody('{"partialSuccess":{"rejectedSpans":0}}');
            }
            return res;
        }
    }

    private static A365_Observability_Config__mdt cfg(Boolean enabled) {
        return new A365_Observability_Config__mdt(
            Enabled__c = enabled,
            TenantId__c = TENANT,
            AgentId__c = AGENT,
            IngestBase__c = 'https://agent365.svc.cloud.microsoft',
            ObsScope__c = 'api://9b975845-388f-4429-889e-eab1ef63949c/.default',
            FmiScope__c = 'api://AzureADTokenExchange/.default',
            UseS2SEndpoint__c = true,
            ServiceName__c = 'salesforce-apex');
    }

    @IsTest
    static void emitToolSpan_enabled_enqueuesAndPostsSpanWithInboundTrace() {
        A365ObsConfig.overrideRecord = cfg(true);
        A365ObsToken.clearCache();
        MultiMock mock = new MultiMock();
        Test.setMock(HttpCalloutMock.class, mock);

        Test.startTest();
        A365Telemetry.emitToolSpan(
            TRACEPARENT, 'execute_tool A365ToolRest', 'SERVER',
            new Map<String, Object>{ 'gen_ai.operation.name' => 'execute_tool' },
            1750000000000000000L, 1750000000123000000L, true);
        Test.stopTest(); // flushes the Queueable

        System.assertEquals(2, mock.tokenCalls, 'two token hops ran');
        System.assertEquals(1, mock.ingestCalls, 'one ingest POST');
        System.assertEquals('Bearer FAKE_OBS_TOKEN', mock.lastAuthHeader, 'Bearer agent-bound token');
        System.assertEquals(TENANT, mock.lastTenantHeader, 'x-ms-tenant-id header set');

        // The emitted span reuses the inbound traceId + parentSpanId (correlation proof).
        Map<String, Object> root = (Map<String, Object>) JSON.deserializeUntyped(mock.lastIngestBody);
        Map<String, Object> rs = (Map<String, Object>) ((List<Object>) root.get('resourceSpans'))[0];
        Map<String, Object> ss = (Map<String, Object>) ((List<Object>) rs.get('scopeSpans'))[0];
        Map<String, Object> span = (Map<String, Object>) ((List<Object>) ss.get('spans'))[0];
        System.assertEquals(TRACE, span.get('traceId'), 'span reuses inbound traceId');
        System.assertEquals(PARENT, span.get('parentSpanId'), 'span nests under inbound parent');
    }

    @IsTest
    static void emitToolSpan_disabled_isNoOp() {
        A365ObsConfig.overrideRecord = cfg(false);
        MultiMock mock = new MultiMock();
        Test.setMock(HttpCalloutMock.class, mock);

        Test.startTest();
        A365Telemetry.emitToolSpan(
            TRACEPARENT, 'execute_tool A365ToolRest', 'SERVER',
            new Map<String, Object>{ 'gen_ai.operation.name' => 'execute_tool' },
            1L, 2L, true);
        Test.stopTest();

        System.assertEquals(0, mock.tokenCalls, 'disabled => no token call');
        System.assertEquals(0, mock.ingestCalls, 'disabled => no ingest call');
    }

    @IsTest
    static void emitToolSpan_blankTraceparent_isNoOp() {
        A365ObsConfig.overrideRecord = cfg(true);
        MultiMock mock = new MultiMock();
        Test.setMock(HttpCalloutMock.class, mock);

        Test.startTest();
        A365Telemetry.emitToolSpan(
            null, 'execute_tool A365ToolRest', 'SERVER', null, 1L, 2L, true);
        A365Telemetry.emitToolSpan(
            'not-a-traceparent', 'execute_tool A365ToolRest', 'SERVER', null, 1L, 2L, true);
        Test.stopTest();

        System.assertEquals(0, mock.ingestCalls, 'no/invalid traceparent => never emits');
    }

    @IsTest
    static void emitToolSpan_ingestFails_failsOpen() {
        A365ObsConfig.overrideRecord = cfg(true);
        A365ObsToken.clearCache();
        MultiMock mock = new MultiMock();
        mock.ingestStatus = 500;
        Test.setMock(HttpCalloutMock.class, mock);

        Test.startTest();
        // Must not throw even though ingest returns 500.
        A365Telemetry.emitToolSpan(
            TRACEPARENT, 'execute_tool A365ToolRest', 'SERVER',
            new Map<String, Object>{ 'gen_ai.operation.name' => 'execute_tool' },
            1L, 2L, false);
        Test.stopTest();

        System.assertEquals(1, mock.ingestCalls, 'ingest attempted once');
        // Reaching here without an exception is the fail-open assertion.
        System.assert(true, 'caller unaffected by ingest 500');
    }

    @IsTest
    static void getToken_cachesWithinTransaction_noRePost() {
        A365ObsConfig.overrideRecord = cfg(true);
        A365ObsToken.clearCache();
        MultiMock mock = new MultiMock();
        Test.setMock(HttpCalloutMock.class, mock);

        Test.startTest();
        String first = A365ObsToken.getToken();
        String second = A365ObsToken.getToken();
        Test.stopTest();

        System.assertEquals('FAKE_OBS_TOKEN', first, 'first acquisition returns obs token');
        System.assertEquals(first, second, 'second call returns the cached token');
        System.assertEquals(2, mock.tokenCalls, 'cache hit => no second token exchange');
    }
}