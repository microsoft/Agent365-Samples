// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Unit tests for the deterministic origination seed helpers (pure — no callouts).
// These ids make spans from independent Apex transactions converge on one trace.
@IsTest
private class A365TraceSeedTest {

    @IsTest
    static void traceIdFromSeed_is32HexDeterministicNonZero() {
        String a = A365Trace.traceIdFromSeed('abc');
        String b = A365Trace.traceIdFromSeed('abc');
        System.assertEquals(32, a.length(), '32 hex chars');
        System.assert(Pattern.matches('[0-9a-f]{32}', a), 'lowercase hex');
        System.assertEquals(a, b, 'deterministic: same seed => same traceId');
        System.assertNotEquals('00000000000000000000000000000000', a, 'non-zero');
    }

    @IsTest
    static void spanIdFromSeed_is16HexDeterministicNonZero() {
        String a = A365Trace.spanIdFromSeed('abc');
        String b = A365Trace.spanIdFromSeed('abc');
        System.assertEquals(16, a.length(), '16 hex chars');
        System.assert(Pattern.matches('[0-9a-f]{16}', a), 'lowercase hex');
        System.assertEquals(a, b, 'deterministic: same seed => same spanId');
        System.assertNotEquals('0000000000000000', a, 'non-zero');
    }

    @IsTest
    static void rootSpanId_differsFromTraceIdPrefix() {
        String seed = 'sample-session-0001';
        String traceId = A365Trace.traceIdFromSeed(seed);
        String spanId = A365Trace.spanIdFromSeed(seed);
        // span derives from SHA-256(seed + ':root'), trace from SHA-256(seed) — different domains.
        System.assertNotEquals(traceId.substring(0, 16), spanId,
            'rootSpanId must not equal the first 16 hex of the traceId');
    }

    @IsTest
    static void differentSeeds_yieldDifferentIds() {
        System.assertNotEquals(
            A365Trace.traceIdFromSeed('session-A'),
            A365Trace.traceIdFromSeed('session-B'),
            'different seeds => different traceIds');
        // A one-character change must fully scatter the digest (avalanche).
        System.assertNotEquals(
            A365Trace.traceIdFromSeed('sample-session-0001'),
            A365Trace.traceIdFromSeed('sample-session-0002'),
            'tiny seed change => fully different traceId');
        System.assertNotEquals(
            A365Trace.spanIdFromSeed('session-A'),
            A365Trace.spanIdFromSeed('session-B'),
            'different seeds => different spanIds');
    }

    @IsTest
    static void blankSeed_stillProducesValidNonZeroIds() {
        // Defensive: even an empty seed yields well-formed, non-zero ids (never throws).
        System.assertEquals(32, A365Trace.traceIdFromSeed('').length(), 'empty seed traceId 32 hex');
        System.assertEquals(16, A365Trace.spanIdFromSeed('').length(), 'empty seed spanId 16 hex');
    }
}