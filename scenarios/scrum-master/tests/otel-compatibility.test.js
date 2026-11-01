// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { test, mock } = require('node:test');

test('patched Jaeger propagator ignores malformed headers and retains valid trace context', () => {
    const { context, trace, defaultTextMapGetter } = require('@opentelemetry/api');
    const { JaegerPropagator } = require('@opentelemetry/propagator-jaeger');
    const propagator = new JaegerPropagator();
    const base = context.active();
    for (const headers of [{ 'uber-trace-id': '%' }, { 'uberctx-user': '%' }]) {
        assert.doesNotThrow(() => propagator.extract(base, headers, defaultTextMapGetter));
    }
    const valid = propagator.extract(base, {
        'uber-trace-id': '11111111111111111111111111111111:2222222222222222:0:1',
    }, defaultTextMapGetter);
    assert.equal(trace.getSpanContext(valid).traceId, '11111111111111111111111111111111');
});

test('patched OpenTelemetry SDK preserves A365 scope initialization and export processing offline', async () => {
    const keys = ['ENABLE_A365_OBSERVABILITY_EXPORTER', 'OTEL_METRICS_EXPORTER', 'OTEL_LOGS_EXPORTER'];
    const previous = keys.map(key => process.env[key]);
    process.env.ENABLE_A365_OBSERVABILITY_EXPORTER = 'false';
    process.env.OTEL_METRICS_EXPORTER = 'none';
    process.env.OTEL_LOGS_EXPORTER = 'none';
    const { ConsoleSpanExporter } = require('@opentelemetry/sdk-trace-base');
    const captured = [];
    const exporter = mock.method(ConsoleSpanExporter.prototype, 'export', (spans, callback) => {
        captured.push(...spans);
        callback({ code: 0 });
    });
    const { ObservabilityManager } = require('@microsoft/agents-a365-observability');
    const manager = ObservabilityManager.configure(builder => builder.withService('Offline compatibility', '1.0'));
    const obs = require('../src/observability.ts');
    const context = {
        activity: {
            channelId: 'msteams', conversation: { id: 'offline-sdk-validation' },
            recipient: {
                agenticAppId: '22222222-2222-4222-8222-222222222222',
                tenantId: '11111111-1111-4111-8111-111111111111',
            },
            from: { aadObjectId: '55555555-5555-4555-8555-555555555555' },
        },
    };
    try {
        manager.start();
        await obs.runWithTurnBaggage(context, () => obs.withInvokeAgentScope(context, 'offline input', () =>
            obs.withExecuteToolScope('offline_tool', { value: 1 }, async () => 'offline output')));
        await manager.shutdown();
        const semantic = captured.filter(span => span.attributes['gen_ai.operation.name']);
        assert.deepEqual(semantic.map(span => span.attributes['gen_ai.operation.name']).sort(), ['execute_tool', 'invoke_agent']);
        assert.ok(semantic.every(span => span.attributes['gen_ai.agent.id'] === context.activity.recipient.agenticAppId));
    } finally {
        await manager.shutdown();
        exporter.mock.restore();
        keys.forEach((key, index) => {
            if (previous[index] === undefined) delete process.env[key];
            else process.env[key] = previous[index];
        });
    }
});
