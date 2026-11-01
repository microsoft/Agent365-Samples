// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Unit tests for A365ObsSpan (pure — no callouts). Asserts the live exporter wire shape:
// flat-map attributes, string kind/status, numeric *UnixNano, trace/parent reuse.
@IsTest
private class A365ObsSpanTest {

    private static final String TENANT = '11111111-1111-1111-1111-111111111111';
    private static final String AGENT = '22222222-2222-2222-2222-222222222222';
    private static final String TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
    private static final String PARENT = '00f067aa0ba902b7';
    private static final String SPAN_ID = '00f067aa0ba90211';

    private static Map<String, Object> firstSpan(String body) {
        Map<String, Object> root = (Map<String, Object>) JSON.deserializeUntyped(body);
        List<Object> resourceSpans = (List<Object>) root.get('resourceSpans');
        Map<String, Object> rs = (Map<String, Object>) resourceSpans[0];
        List<Object> scopeSpans = (List<Object>) rs.get('scopeSpans');
        Map<String, Object> ss = (Map<String, Object>) scopeSpans[0];
        List<Object> spans = (List<Object>) ss.get('spans');
        return (Map<String, Object>) spans[0];
    }

    private static Map<String, Object> resourceAttrs(String body) {
        Map<String, Object> root = (Map<String, Object>) JSON.deserializeUntyped(body);
        Map<String, Object> rs = (Map<String, Object>) ((List<Object>) root.get('resourceSpans'))[0];
        Map<String, Object> resource = (Map<String, Object>) rs.get('resource');
        return (Map<String, Object>) resource.get('attributes');
    }

    @IsTest
    static void buildBody_reusesTraceAndParent() {
        String body = A365ObsSpan.buildBody(TENANT, AGENT, TRACE, PARENT, SPAN_ID,
            'execute_tool A365ToolRest', 'SERVER', 'OK',
            new Map<String, Object>{ 'gen_ai.operation.name' => 'execute_tool' });

        Map<String, Object> span = firstSpan(body);
        System.assertEquals(TRACE, (String) span.get('traceId'), 'traceId reused, not regenerated');
        System.assertEquals(PARENT, (String) span.get('parentSpanId'), 'parentSpanId reused');
        System.assertEquals(SPAN_ID, (String) span.get('spanId'), 'spanId as provided');
        System.assertEquals('execute_tool A365ToolRest', (String) span.get('name'), 'name');
        System.assertEquals('SERVER', (String) span.get('kind'), 'kind is a string enum');
    }

    @IsTest
    static void buildBody_stringStatusAndFlatAttributes() {
        String body = A365ObsSpan.buildBody(TENANT, AGENT, TRACE, PARENT, SPAN_ID,
            'execute_tool A365ToolRest', 'SERVER', 'OK',
            new Map<String, Object>{
                'gen_ai.operation.name' => 'execute_tool',
                'sf.prompt.len' => 19
            });

        Map<String, Object> span = firstSpan(body);
        // status.code is a STRING enum, not an integer.
        Map<String, Object> status = (Map<String, Object>) span.get('status');
        System.assertEquals('OK', status.get('code'), 'status.code string enum');

        // attributes is a flat MAP, not an array of {key,value}.
        Object attrsObj = span.get('attributes');
        System.assert(attrsObj instanceof Map<String, Object>, 'attributes is a flat map');
        Map<String, Object> attrs = (Map<String, Object>) attrsObj;
        System.assertEquals('execute_tool', attrs.get('gen_ai.operation.name'), 'op name');
        System.assertEquals(19, attrs.get('sf.prompt.len'), 'numeric attr preserved');
        // gen_ai.agent.id auto-added to the span attributes.
        System.assertEquals(AGENT, attrs.get('gen_ai.agent.id'), 'agent id on span');
    }

    @IsTest
    static void buildBody_resourceAttributesPresent() {
        String body = A365ObsSpan.buildBody(TENANT, AGENT, TRACE, PARENT, SPAN_ID,
            'execute_tool A365ToolRest', 'SERVER', 'OK', null);
        Map<String, Object> ra = resourceAttrs(body);
        System.assertEquals(TENANT, ra.get('microsoft.tenant.id'), 'resource tenant id');
        System.assertEquals(AGENT, ra.get('gen_ai.agent.id'), 'resource agent id');
        System.assertEquals('salesforce-apex', ra.get('service.name'), 'service name');
        System.assertEquals('apex', ra.get('telemetry.sdk.language'), 'sdk language');
    }

    @IsTest
    static void buildBody_timestampsAreNumbers() {
        Long startNs = 1750000000000000000L;
        Long endNs = 1750000000123000000L;
        String body = A365ObsSpan.buildBody(TENANT, AGENT, TRACE, PARENT, SPAN_ID,
            'execute_tool A365ToolRest', 'SERVER', 'OK', null, startNs, endNs);

        // Serialized as bare JSON numbers (no quotes).
        System.assert(body.contains('"startTimeUnixNano":1750000000000000000'),
            'start ns serialized as number: ' + body);
        System.assert(body.contains('"endTimeUnixNano":1750000000123000000'),
            'end ns serialized as number');

        Map<String, Object> span = firstSpan(body);
        System.assertEquals(startNs, (Long) span.get('startTimeUnixNano'), 'start ns value');
        System.assertEquals(endNs, (Long) span.get('endTimeUnixNano'), 'end ns value');
    }

    @IsTest
    static void buildBody_omitsParentWhenBlank() {
        String body = A365ObsSpan.buildBody(TENANT, AGENT, TRACE, null, SPAN_ID,
            'execute_tool A365ToolRest', 'SERVER', 'OK', null);
        Map<String, Object> span = firstSpan(body);
        System.assert(!span.containsKey('parentSpanId'), 'root span omits parentSpanId');
    }
}