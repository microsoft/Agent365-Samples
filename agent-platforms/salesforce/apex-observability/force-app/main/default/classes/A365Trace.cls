// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// A365Trace — W3C Trace Context helpers for native Apex Agent 365 observability.
//
// Parses the inbound `traceparent` header so a Salesforce-originated OTLP span can
// reuse the agent turn's traceId and nest under its `execute_tool` span, and mints
// fresh span ids. `newTraceId()` exists only for illustration (a real flow must
// never fabricate a trace — no traceparent => no span).
//
// W3C traceparent format:  version(2) "-" traceId(32hex) "-" parentId(16hex) "-" flags(2)
//   e.g.  00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
public with sharing class A365Trace {

    // Result of parsing a traceparent header. `traceId`/`parentSpanId` are null when
    // the header is missing or malformed; callers treat null as "no trace => no-op".
    public class TraceContext {
        public String traceId;
        public String parentSpanId;
        public Boolean sampled;
    }

    // Parse a W3C `traceparent`. Returns null for blank/malformed input so callers can
    // short-circuit to a no-op rather than inventing a trace.
    public static TraceContext parseTraceparent(String header) {
        if (String.isBlank(header)) {
            return null;
        }
        List<String> parts = header.trim().split('-');
        if (parts.size() < 4) {
            return null;
        }
        String version = parts[0];
        String traceId = parts[1];
        String parentId = parts[2];
        String flags = parts[3];

        if (!isHex(traceId, 32) || !isHex(parentId, 16) || !isHex(version, 2) || !isHex(flags, 2)) {
            return null;
        }
        // An all-zero trace or parent id is invalid per the spec.
        if (isAllZero(traceId) || isAllZero(parentId)) {
            return null;
        }

        TraceContext ctx = new TraceContext();
        ctx.traceId = traceId.toLowerCase();
        ctx.parentSpanId = parentId.toLowerCase();
        // Sampled flag is the low bit of the flags byte (low bit of the last hex digit).
        Integer lowNibble = '0123456789abcdef'.indexOf(flags.substring(1, 2).toLowerCase());
        ctx.sampled = lowNibble >= 0 && Math.mod(lowNibble, 2) == 1;
        return ctx;
    }

    // 16 hex chars (8 random bytes) — an OTLP span id.
    public static String newSpanId() {
        return randomHex(8);
    }

    // 32 hex chars (16 random bytes) — an OTLP trace id. Illustration-only.
    public static String newTraceId() {
        return randomHex(16);
    }

    // --- Deterministic origination (Agentforce-native telemetry) ----------------------
    //
    // When SALESFORCE originates a trace (no inbound traceparent), both the traceId and the
    // root `invoke_agent` span id are derived deterministically from the Agentforce session
    // id. Any emitter that knows the session id computes identical ids — so spans emitted
    // from independent Apex transactions (each action, each Queueable) converge
    // on ONE trace nested under ONE root, with no shared/cross-transaction state.

    // 32-hex OTLP trace id from a session seed: first 16 bytes of SHA-256(seed). Non-zero.
    public static String traceIdFromSeed(String seed) {
        return hexDigestFromSeed(seed, 32);
    }

    // 16-hex root (`invoke_agent`) span id from a session seed: first 8 bytes of
    // SHA-256(seed + ':root'). Distinct domain from traceIdFromSeed so the two never collide.
    public static String spanIdFromSeed(String seed) {
        return hexDigestFromSeed(seed + ':root', 16);
    }

    // SHA-256(input) -> first `hexLen` lowercase hex chars, guaranteed non-zero per the W3C
    // spec (re-hash with a counter suffix in the astronomically unlikely all-zero case).
    private static String hexDigestFromSeed(String input, Integer hexLen) {
        String s = (input == null) ? '' : input;
        for (Integer attempt = 0; attempt < 5; attempt++) {
            String salted = (attempt == 0) ? s : s + ':' + attempt;
            Blob digest = Crypto.generateDigest('SHA-256', Blob.valueOf(salted));
            String hex = EncodingUtil.convertToHex(digest).substring(0, hexLen).toLowerCase();
            if (!isAllZero(hex)) {
                return hex;
            }
        }
        // Unreachable in practice — a deterministic, non-zero fallback of the right length.
        String fallback = '';
        while (fallback.length() < hexLen) {
            fallback += '1';
        }
        return fallback;
    }

    private static String randomHex(Integer numBytes) {
        // Crypto.generateAesKey(128) yields 16 cryptographically-random bytes (32 hex).
        Blob key = Crypto.generateAesKey(128);
        String hex = EncodingUtil.convertToHex(key); // 32 hex chars
        return hex.substring(0, numBytes * 2).toLowerCase();
    }

    private static Boolean isHex(String s, Integer len) {
        if (s == null || s.length() != len) {
            return false;
        }
        return Pattern.matches('[0-9a-fA-F]{' + len + '}', s);
    }

    private static Boolean isAllZero(String s) {
        for (Integer i = 0; i < s.length(); i++) {
            if (s.charAt(i) != 48) { // '0'
                return false;
            }
        }
        return true;
    }
}