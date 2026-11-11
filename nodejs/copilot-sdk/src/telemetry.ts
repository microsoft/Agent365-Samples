// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { trace, type Span } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor, InMemorySpanExporter, SimpleSpanProcessor, AlwaysOffSampler,
  type SpanExporter, type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  Agent365Exporter, ExecuteToolScope, InvokeAgentScope,
  type AgentDetails, type TokenResolver,
} from '@microsoft/opentelemetry';
import type { SessionEvent, ToolInvocation } from '@github/copilot-sdk';
import { OBSERVABILITY_SCOPE } from './auth.js';
import { SDK_VERSION, RUNTIME_VERSION, type SampleConfig } from './config.js';

interface ToolSpan {
  scope: ExecuteToolScope;
  handlerFailed: boolean;
}

function telemetryError(message: string): Error {
  const error = new Error(message);
  delete error.stack;
  return error;
}

export class InvocationTelemetry {
  private readonly seen = new Set<string>();
  private readonly tools = new Map<string, ToolSpan>();
  private readonly completed = new Set<string>();
  private errorSeen = false;
  private closed = false;
  private toolFailures = 0;
  private correlationGaps = 0;

  constructor(
    readonly sessionId: string,
    private readonly root: InvokeAgentScope,
    private readonly span: Span,
    private readonly agent: AgentDetails,
  ) {}

  onEvent(event: SessionEvent): void {
    if (this.closed || this.seen.has(event.id)) return;
    this.seen.add(event.id);
    const attributes: Record<string, string | number | boolean> = { 'copilot.event.id': event.id };
    if (event.agentId) attributes['copilot.runtime.agent_id'] = event.agentId;
    switch (event.type) {
      case 'session.start':
      case 'session.idle':
      case 'assistant.turn_start':
      case 'assistant.turn_end':
        break;
      case 'session.error':
        this.errorSeen = true;
        this.root.recordError(telemetryError('Copilot reported a session error'));
        break;
      case 'tool.execution_start':
        if (this.completed.has(event.data.toolCallId)) {
          this.correlationGaps++;
        } else {
          this.startTool(event.data.toolCallId, event.data.toolName, event.agentId);
        }
        attributes['gen_ai.tool.call.id'] = event.data.toolCallId;
        break;
      case 'tool.execution_complete': {
        const id = event.data.toolCallId;
        if (this.completed.has(id)) return;
        const tool = this.tools.get(id);
        attributes['gen_ai.tool.call.id'] = id;
        attributes['copilot.tool.success'] = event.data.success;
        if (!tool) {
          this.correlationGaps++;
        } else {
          if (!event.data.success && !tool.handlerFailed) {
            tool.scope.recordError(telemetryError('Copilot tool execution failed'));
            this.toolFailures++;
          }
          tool.scope.dispose();
          this.tools.delete(id);
        }
        this.completed.add(id);
        break;
      }
      case 'assistant.usage':
        // Usage is post-hoc reporting, not an observable inference start/end boundary.
        attributes['gen_ai.request.model'] = event.data.model;
        for (const [key, value] of Object.entries({
          'gen_ai.usage.input_tokens': event.data.inputTokens,
          'gen_ai.usage.output_tokens': event.data.outputTokens,
          'copilot.reported.duration_ms': event.data.duration,
          'copilot.usage.cache_read_tokens': event.data.cacheReadTokens,
          'copilot.usage.cache_write_tokens': event.data.cacheWriteTokens,
        })) {
          if (value !== undefined && Number.isFinite(value)) attributes[key] = value;
        }
        break;
      default:
        return;
    }
    // Deliberately omit prompts, arguments, outputs, reasoning and SDK error messages.
    this.span.addEvent(event.type, attributes);
  }

  private startTool(id: string, name: string, runtimeAgentId?: string): ToolSpan {
    if (this.completed.has(id)) throw new Error('Tool call ID was reused after completion');
    const existing = this.tools.get(id);
    if (existing) return existing;
    const scope = ExecuteToolScope.start(
      { sessionId: this.sessionId, conversationId: this.sessionId },
      { toolName: name, toolCallId: id, toolType: 'function' },
      this.agent,
      undefined,
      { parentContext: this.root.getSpanContext() },
    );
    scope.recordAttributes({
      'copilot.timing.source': 'application_observed_tool_lifecycle',
      ...(runtimeAgentId ? { 'copilot.runtime.agent_id': runtimeAgentId } : {}),
    });
    const tool = { scope, handlerFailed: false };
    this.tools.set(id, tool);
    return tool;
  }

  async executeTool<T>(invocation: ToolInvocation, action: () => T | Promise<T>): Promise<T> {
    if (this.closed || invocation.sessionId !== this.sessionId) {
      throw new Error('Tool invocation does not belong to the active session');
    }
    const tool = this.startTool(invocation.toolCallId, invocation.toolName);
    return tool.scope.withActiveSpanAsync(async () => {
      try {
        return await action();
      } catch (error) {
        tool.handlerFailed = true;
        this.toolFailures++;
        tool.scope.recordError(telemetryError('Custom tool handler failed'));
        throw error;
      } finally {
        tool.scope.recordAttributes({ 'copilot.handler.completed': true });
      }
    });
  }

  assertSessionHealthy(): void {
    if (this.errorSeen) throw new Error('Copilot session failed; inspect GitHub authentication and model access');
    if (this.correlationGaps) throw new Error('Copilot tool event correlation was incomplete');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const tool of this.tools.values()) {
      tool.scope.recordError(telemetryError('Tool completion was not observed before invocation cleanup'));
      tool.scope.recordCancellation('Invocation ended with an unfinished tool');
      tool.scope.dispose();
      this.correlationGaps++;
    }
    this.tools.clear();
    this.root.recordAttributes({
      'copilot.tool.failures': this.toolFailures,
      'copilot.correlation.gaps': this.correlationGaps,
    });
    if (this.correlationGaps > 0) this.root.recordError(telemetryError('Incomplete tool event correlation'));
  }
}

export function createTelemetry(config: SampleConfig, tokenResolver?: TokenResolver) {
  if (config.exportToA365 && !tokenResolver) throw new Error('Live A365 export requires an explicit token resolver');
  const memory = new InMemorySpanExporter();
  const processors: SpanProcessor[] = [new SimpleSpanProcessor(memory)];
  let exportFailed = false;
  if (config.exportToA365) {
    const remote = new Agent365Exporter({
      tokenResolver: tokenResolver!,
      useS2SEndpoint: true,
      authScopes: [OBSERVABILITY_SCOPE],
      clusterCategory: 'prod',
      httpRequestTimeoutMilliseconds: 15000,
      exporterTimeoutMilliseconds: 60000,
    });
    const checked: SpanExporter = {
      export: (spans, callback) => {
        void remote.export(spans, result => {
          if (result.code !== ExportResultCode.SUCCESS) exportFailed = true;
          callback(result);
        });
      },
      shutdown: () => remote.shutdown(),
      forceFlush: () => remote.forceFlush(),
    };
    processors.push(new BatchSpanProcessor(checked, remote.getBufferConfig()));
  }
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': 'agent365-copilot-sdk-sample',
      'service.version': '0.1.0',
      'copilot.sdk.version': SDK_VERSION,
      'copilot.runtime.expected_version': RUNTIME_VERSION,
      'sample.export.mode': config.exportToA365 ? 'a365' : 'local-only',
    }),
    spanProcessors: processors,
    ...(!config.observability ? { sampler: new AlwaysOffSampler() } : {}),
  });
  provider.register();
  return {
    async invoke<T>(sessionId: string, action: (events: InvocationTelemetry) => Promise<T>): Promise<T> {
      const scope = InvokeAgentScope.start(
        { sessionId, conversationId: sessionId, channel: { name: 'console' } },
        {},
        config.agent,
      );
      try {
        return await scope.withActiveSpanAsync(async () => {
          const span = trace.getActiveSpan();
          if (!span) throw new Error('Invocation span context was not established');
          const events = new InvocationTelemetry(sessionId, scope, span, config.agent);
          try {
            const result = await action(events);
            events.close();
            events.assertSessionHealthy();
            return result;
          } finally {
            events.close();
          }
        });
      } catch (error) {
        scope.recordError(telemetryError('Copilot invocation failed'));
        throw error;
      } finally {
        scope.dispose();
      }
    },
    snapshot() {
      return memory.getFinishedSpans().map(span => ({
        name: span.name,
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        parentSpanId: span.parentSpanContext?.spanId,
        attributes: span.attributes,
        events: span.events,
        status: span.status,
        durationMs: span.duration[0] * 1000 + span.duration[1] / 1e6,
      }));
    },
    async shutdown() {
      try {
        await provider.forceFlush();
      } finally {
        await provider.shutdown();
      }
      if (exportFailed) throw new Error('A365 exporter reported a failure; ingestion is not verified');
    },
  };
}

export type SampleTelemetry = ReturnType<typeof createTelemetry>;
