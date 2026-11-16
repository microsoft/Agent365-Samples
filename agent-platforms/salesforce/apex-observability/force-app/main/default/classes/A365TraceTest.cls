// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Unit tests for A365Trace (pure — no callouts).
@IsTest
private class A365TraceTest {

    @IsTest
    static void parseTraceparent_validHeader() {
        String tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
        A365Trace.TraceContext ctx = A365Trace.parseTraceparent(tp);
        System.assertNotEquals(null, ctx, 'Expected a parsed context');
        System.assertEquals('4bf92f3577b34da6a3ce929d0e0e4736', ctx.traceId, 'traceId');
        System.assertEquals('00f067aa0ba902b7', ctx.parentSpanId, 'parentSpanId');
        System.assertEquals(true, ctx.sampled, 'sampled flag set');
    }

    @IsTest
    static void parseTraceparent_notSampled() {
        A365Trace.TraceContext ctx =
            A365Trace.parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00');
        System.assertEquals(false, ctx.sampled, 'sampled flag clear');
    }

    @IsTest
    static void parseTraceparent_blankOrMalformed_returnsNull() {
        System.assertEquals(null, A365Trace.parseTraceparent(null), 'null header');
        System.assertEquals(null, A365Trace.parseTraceparent(''), 'empty header');
        System.assertEquals(null, A365Trace.parseTraceparent('not-a-traceparent'), 'too few parts');
        System.assertEquals(null,
            A365Trace.parseTraceparent('00-zzzz-00f067aa0ba902b7-01'), 'non-hex traceId');
        System.assertEquals(null,
            A365Trace.parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01'),
            'all-zero traceId invalid');
    }

    @IsTest
    static void newSpanId_is16Hex() {
        String s = A365Trace.newSpanId();
        System.assertEquals(16, s.length(), '16 hex chars');
        System.assert(Pattern.matches('[0-9a-f]{16}', s), 'lowercase hex');
        System.assertNotEquals('0000000000000000', s, 'non-zero');
    }

    @IsTest
    static void newTraceId_is32Hex() {
        String t = A365Trace.newTraceId();
        System.assertEquals(32, t.length(), '32 hex chars');
        System.assert(Pattern.matches('[0-9a-f]{32}', t), 'lowercase hex');
    }
}