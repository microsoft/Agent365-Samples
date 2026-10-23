// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SessionEvent } from '@github/copilot-sdk';
import type { SampleTelemetry } from './telemetry.js';
import { createTools } from './tools.js';

export function eventMetadata() {
  return { id: randomUUID(), timestamp: new Date().toISOString(), parentId: null };
}

export async function runOfflineSmoke(telemetry: SampleTelemetry): Promise<void> {
  await telemetry.invoke('offline-smoke', async events => {
    const tools = createTools(events);
    for (const [index, tool] of tools.entries()) {
      assert.ok(tool.handler);
      const toolCallId = `offline-tool-${index}`;
      const args = tool.name === 'add_numbers' ? { a: 19, b: 23 } : {};
      const started: SessionEvent = {
        ...eventMetadata(), type: 'tool.execution_start',
        data: { toolCallId, toolName: tool.name },
      };
      events.onEvent(started);
      const action = () => Promise.resolve(tool.handler!(args, {
        sessionId: 'offline-smoke', toolCallId, toolName: tool.name, arguments: args,
      }));
      if (tool.name === 'add_numbers') {
        assert.equal(await action(), 42);
      } else {
        await assert.rejects(action, /Intentional deterministic tool failure/);
      }
      events.onEvent({
        ...eventMetadata(), type: 'tool.execution_complete',
        data: { toolCallId, success: tool.name === 'add_numbers' },
      });
    }
  });
  const spans = telemetry.snapshot();
  assert.equal(spans.length, 3);
  assert.equal(spans.filter(span => span.status.code === 2).length, 1);
  assert.equal(new Set(spans.map(span => span.traceId)).size, 1);
  assert.ok(spans.every(span => span.attributes['microsoft.tenant.id'] === 'local-only'));
}
