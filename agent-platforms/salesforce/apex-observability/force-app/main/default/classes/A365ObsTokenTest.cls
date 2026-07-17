// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Unit tests for A365ObsToken. Mocks the two token-endpoint POSTs (Hop 1/2, Hop 3) and
// asserts each hop's form body, plus that getTokenNoCache() returns the Hop-3 token.
@IsTest
private class A365ObsTokenTest {

    // Records each request so the test can assert hop ordering + body contents, and
    // returns a fake T1 first then a fake observability token.
    private class TokenMock implements HttpCalloutMock {
        public Integer calls = 0;
        public List<String> bodies = new List<String>();
        public List<String> endpoints = new List<String>();

        public HttpResponse respond(HttpRequest req) {
            calls++;
            bodies.add(req.getBody());
            endpoints.add(req.getEndpoint());
            System.assertEquals('POST', req.getMethod(), 'token POST');
            System.assertEquals('application/x-www-form-urlencoded',
                req.getHeader('Content-Type'), 'form-encoded body');

            HttpResponse res = new HttpResponse();
            res.setStatusCode(200);
            res.setHeader('Content-Type', 'application/json');
            String accessToken = (calls == 1) ? 'FAKE_T1_ASSERTION' : 'FAKE_OBS_TOKEN';
            res.setBody('{"token_type":"Bearer","expires_in":3599,"access_token":"' + accessToken + '"}');
            return res;
        }
    }

    @IsTest
    static void getTokenNoCache_doesBothHops_returnsObsToken() {
        TokenMock mock = new TokenMock();
        Test.setMock(HttpCalloutMock.class, mock);

        Test.startTest();
        String token = A365ObsToken.getTokenNoCache();
        Test.stopTest();

        System.assertEquals('FAKE_OBS_TOKEN', token, 'returns the Hop-3 obs token');
        System.assertEquals(2, mock.calls, 'exactly two token POSTs (Hop1/2 + Hop3)');

        // Hop 1/2 body: fmi_path + AzureADTokenExchange scope, via the Basic-header NC.
        String hop12 = mock.bodies[0];
        System.assert(hop12.contains('grant_type=client_credentials'), 'hop1/2 grant');
        System.assert(hop12.contains('fmi_path='), 'hop1/2 has fmi_path');
        System.assert(hop12.contains('AzureADTokenExchange'), 'hop1/2 FMI scope');
        System.assert(mock.endpoints[0].contains('A365_Obs_Token/'), 'hop1/2 uses Basic NC');

        // Hop 3 body: jwt-bearer client-assertion = T1, client_id = agentId, obs scope.
        String hop3 = mock.bodies[1];
        System.assert(hop3.contains('client_assertion_type='), 'hop3 assertion type');
        System.assert(hop3.contains('jwt-bearer'), 'hop3 jwt-bearer grant');
        System.assert(hop3.contains('client_assertion=FAKE_T1_ASSERTION'), 'hop3 carries T1');
        System.assert(hop3.contains('client_id='), 'hop3 client_id');
        System.assert(hop3.contains('9b975845'), 'hop3 obs scope');
        System.assert(mock.endpoints[1].contains('A365_Obs_TokenJwt/'), 'hop3 uses no-auth NC');
    }

    @IsTest
    static void tokenRequest_nonSuccess_throws() {
        Test.setMock(HttpCalloutMock.class, new FailMock());
        Test.startTest();
        try {
            A365ObsToken.getTokenNoCache();
            System.assert(false, 'expected an exception on HTTP 401');
        } catch (A365ObsToken.A365ObsTokenException e) {
            System.assert(e.getMessage().contains('401'), 'surfaces the HTTP status');
        }
        Test.stopTest();
    }

    private class FailMock implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setStatusCode(401);
            res.setBody('{"error":"invalid_client"}');
            return res;
        }
    }
}