// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Unit test for A365Callout. Apex requires an HttpCalloutMock to test callouts
// and to provide code coverage for deployment.

@IsTest
private class A365CalloutTest {

    private class A365Mock implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest req) {
            // Assert the request looks right.
            System.assertEquals('POST', req.getMethod(), 'Should POST to A365');
            System.assert(req.getEndpoint().endsWith('/callback'), 'Should hit /callback');
            System.assert(req.getBody().contains('salesforce-apex'), 'Body should identify the source');

            HttpResponse res = new HttpResponse();
            res.setStatusCode(200);
            res.setHeader('Content-Type', 'application/json');
            res.setBody('{"ok":true,"reply":"ack from A365"}');
            return res;
        }
    }

    @IsTest
    static void callA365_returnsResponse() {
        Test.setMock(HttpCalloutMock.class, new A365Mock());

        Test.startTest();
        A365Callout.CalloutResult result = A365Callout.callA365('hello from apex');
        Test.stopTest();

        System.assertEquals(200, result.statusCode, 'Expected HTTP 200');
        System.assert(result.responseBody.contains('ack from A365'), 'Expected A365 ack in body');
    }

    @IsTest
    static void callFromFlow_handlesList() {
        Test.setMock(HttpCalloutMock.class, new A365Mock());

        A365Callout.CalloutInput input = new A365Callout.CalloutInput();
        input.message = 'from flow';

        Test.startTest();
        List<A365Callout.CalloutResult> results =
            A365Callout.callFromFlow(new List<A365Callout.CalloutInput>{ input });
        Test.stopTest();

        System.assertEquals(1, results.size(), 'One result expected');
        System.assertEquals(200, results[0].statusCode, 'Expected HTTP 200');
    }

    // ---- Observability emission --------------------------------------

    private static final String TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
    private static final String TRACEPARENT = '00-' + TRACE + '-00f067aa0ba902b7-01';

    // Routes /callback (the real leg) vs token (/oauth2/) vs ingest (/otlp/), so the async
    // CLIENT-span emit can flush alongside the primary callout.
    private class RouterMock implements HttpCalloutMock {
        public Integer ingestCalls = 0;
        public String lastIngestBody;
        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setHeader('Content-Type', 'application/json');
            String ep = req.getEndpoint();
            if (ep.contains('/oauth2/')) {
                res.setStatusCode(200);
                res.setBody('{"access_token":"FAKE","expires_in":3599}');
            } else if (ep.contains('/otlp/')) {
                ingestCalls++;
                lastIngestBody = req.getBody();
                res.setStatusCode(200);
                res.setBody('{"partialSuccess":{"rejectedSpans":0}}');
            } else {
                res.setStatusCode(200);
                res.setBody('{"ok":true,"reply":"ack from A365"}');
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

    @IsTest
    static void callA365_emissionEnabled_resultUnchanged_andEmitsClientSpan() {
        A365ObsConfig.overrideRecord = cfg(true);
        A365ObsToken.clearCache();
        RouterMock mock = new RouterMock();
        Test.setMock(HttpCalloutMock.class, mock);

        Test.startTest();
        A365Callout.CalloutResult result = A365Callout.callA365('hello', TRACEPARENT);
        Test.stopTest();

        // Primary callout contract unchanged.
        System.assertEquals(200, result.statusCode, 'callback still 200');
        System.assert(result.responseBody.contains('ack from A365'), 'callback body unchanged');

        // A CLIENT span was emitted on the inbound trace.
        System.assertEquals(1, mock.ingestCalls, 'one client span emitted');
        System.assert(mock.lastIngestBody.contains(TRACE), 'span reuses inbound traceId');
        System.assert(mock.lastIngestBody.contains('CLIENT'), 'outbound leg is a CLIENT span');
    }

    @IsTest
    static void callA365_emissionDisabled_isNoOp() {
        A365ObsConfig.overrideRecord = cfg(false);
        RouterMock mock = new RouterMock();
        Test.setMock(HttpCalloutMock.class, mock);

        Test.startTest();
        A365Callout.CalloutResult result = A365Callout.callA365('hello', TRACEPARENT);
        Test.stopTest();

        System.assertEquals(200, result.statusCode, 'callback still 200 when disabled');
        System.assertEquals(0, mock.ingestCalls, 'disabled => no emission (regression guard)');
    }
}