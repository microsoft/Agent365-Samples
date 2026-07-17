// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Unit tests for A365ToolRest (REST endpoint + observability emission).

@IsTest
private class A365ToolRestTest {

    @IsTest
    static void doPost_withPrompt_echoesAndReplies() {
        RestRequest req = new RestRequest();
        req.requestURI = '/services/apexrest/a365tool';
        req.httpMethod = 'POST';
        req.requestBody = Blob.valueOf('{"prompt":"hi there"}');
        RestContext.request = req;
        RestContext.response = new RestResponse();

        Test.startTest();
        A365ToolRest.A365Response res = A365ToolRest.doPost();
        Test.stopTest();

        System.assertEquals('hi there', res.echo, 'Prompt should be echoed');
        System.assertEquals('apex', res.source, 'Source should be apex');
        System.assert(res.reply.contains('hi there'), 'Reply should include the prompt');
    }

    @IsTest
    static void doPost_emptyBody_stillReplies() {
        RestRequest req = new RestRequest();
        req.httpMethod = 'POST';
        req.requestBody = Blob.valueOf('');
        RestContext.request = req;
        RestContext.response = new RestResponse();

        A365ToolRest.A365Response res = A365ToolRest.doPost();
        System.assertEquals('apex', res.source);
        System.assert(res.reply.contains('no prompt'), 'Should indicate no prompt received');
    }

    @IsTest
    static void doGet_isAlive() {
        RestContext.request = new RestRequest();
        RestContext.response = new RestResponse();

        A365ToolRest.A365Response res = A365ToolRest.doGet();
        System.assert(res.reply.contains('alive'), 'GET should report alive');
    }

    // ---- Observability emission --------------------------------------

    private static final String TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
    private static final String PARENT = '00f067aa0ba902b7';
    private static final String TRACEPARENT = '00-' + TRACE + '-' + PARENT + '-01';

    // Routes token hops (/oauth2/) vs ingest (/otlp/) so the async emit Queueable can flush.
    private class EmitMock implements HttpCalloutMock {
        public Integer ingestCalls = 0;
        public String lastIngestBody;
        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setHeader('Content-Type', 'application/json');
            if (req.getEndpoint().contains('/oauth2/')) {
                res.setStatusCode(200);
                res.setBody('{"access_token":"FAKE","expires_in":3599}');
            } else {
                ingestCalls++;
                lastIngestBody = req.getBody();
                res.setStatusCode(200);
                res.setBody('{"partialSuccess":{"rejectedSpans":0}}');
            }
            return res;
        }
    }

    private static A365_Observability_Config__mdt cfg(Boolean enabled) {
        return new A365_Observability_Config__mdt(
            Enabled__c = enabled,
            TenantId__c = '11111111-1111-1111-1111-111111111111',
            AgentId__c = '22222222-2222-2222-2222-222222222222',
            IngestBase__c = 'https://agent365.svc.cloud.microsoft',
            ObsScope__c = 'api://9b975845-388f-4429-889e-eab1ef63949c/.default',
            FmiScope__c = 'api://AzureADTokenExchange/.default',
            UseS2SEndpoint__c = true,
            ServiceName__c = 'salesforce-apex');
    }

    private static void postWithTrace() {
        RestRequest req = new RestRequest();
        req.requestURI = '/services/apexrest/a365tool';
        req.httpMethod = 'POST';
        req.addHeader('traceparent', TRACEPARENT);
        req.requestBody = Blob.valueOf('{"prompt":"hi there"}');
        RestContext.request = req;
        RestContext.response = new RestResponse();
    }

    @IsTest
    static void doPost_emissionEnabled_contractUnchanged_andEmits() {
        A365ObsConfig.overrideRecord = cfg(true);
        A365ObsToken.clearCache();
        EmitMock mock = new EmitMock();
        Test.setMock(HttpCalloutMock.class, mock);

        Test.startTest();
        postWithTrace();
        A365ToolRest.A365Response res = A365ToolRest.doPost();
        Test.stopTest(); // flush the async emit

        // Existing response contract must be identical with emission enabled.
        System.assertEquals('hi there', res.echo, 'echo unchanged');
        System.assertEquals('apex', res.source, 'source unchanged');
        System.assertEquals(TRACEPARENT, res.traceparent, 'traceparent echoed');
        System.assert(res.reply.contains('hi there'), 'reply unchanged');

        // The Salesforce span was emitted on the inbound trace.
        System.assertEquals(1, mock.ingestCalls, 'one span emitted');
        System.assert(mock.lastIngestBody.contains(TRACE), 'span reuses inbound traceId');
    }

    @IsTest
    static void doPost_emissionDisabled_isNoOp_contractUnchanged() {
        A365ObsConfig.overrideRecord = cfg(false);
        EmitMock mock = new EmitMock();
        Test.setMock(HttpCalloutMock.class, mock);

        Test.startTest();
        postWithTrace();
        A365ToolRest.A365Response res = A365ToolRest.doPost();
        Test.stopTest();

        System.assertEquals('hi there', res.echo, 'echo unchanged when disabled');
        System.assertEquals('apex', res.source, 'source unchanged when disabled');
        System.assertEquals(0, mock.ingestCalls, 'disabled => no emission (regression guard)');
    }
}