// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const sampleRequire = createRequire(path.resolve(
  __dirname, '../../../nodejs/openai/sample-agent/package.json',
));

global.fetch = async () => { throw new Error('Unexpected network request in offline tracing test'); };

const { trace, context } = sampleRequire('@opentelemetry/api');
const {
  BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor,
} = sampleRequire('@opentelemetry/sdk-trace-base');
const { AsyncLocalStorageContextManager } = sampleRequire('@opentelemetry/context-async-hooks');
const { ObservabilityManager } = sampleRequire('@microsoft/agents-a365-observability');
const { OpenAIAgentsTraceInstrumentor } = sampleRequire('@microsoft/agents-a365-observability-extensions-openai');
const { Agent, Runner, OpenAIProvider } = sampleRequire('@openai/agents');
const OpenAI = sampleRequire('openai');

async function main() {
  const memory = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] });
  const contextManager = new AsyncLocalStorageContextManager().enable();
  assert.equal(context.setGlobalContextManager(contextManager), true);
  assert.equal(trace.setGlobalTracerProvider(provider), true);
  ObservabilityManager.configure(builder => builder.withService('offline-openai-tracing'));
  const instrumentor = new OpenAIAgentsTraceInstrumentor({ enabled: false });
  instrumentor.enable();
  let modelCalls = 0;
  const client = new OpenAI({
    apiKey: 'offline-placeholder',
    baseURL: 'https://offline.invalid/v1',
    maxRetries: 0,
    fetch: async url => {
      assert.equal(String(url), 'https://offline.invalid/v1/responses');
      modelCalls++;
      return new Response(JSON.stringify({
        id: 'resp_offline',
        object: 'response',
        created_at: 1,
        status: 'completed',
        model: 'gpt-4o',
        output: [{
          id: 'msg_offline', type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: '4', annotations: [] }],
        }],
        usage: {
          input_tokens: 5, output_tokens: 1, total_tokens: 6,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const modelProvider = new OpenAIProvider({ openAIClient: client, useResponses: true });
  try {
    const runner = new Runner({ modelProvider, tracingDisabled: false });
    const agent = new Agent({ name: 'Offline dependency regression', model: 'gpt-4o' });
    const result = await runner.run(agent, 'What is 2 plus 2?');
    assert.equal(result.finalOutput, '4');
    assert.equal(modelCalls, 1);
    await provider.forceFlush();
    const operations = memory.getFinishedSpans().map(span => span.attributes['gen_ai.operation.name']);
    assert.ok(operations.includes('invoke_agent'), `Missing agent span: ${JSON.stringify(operations)}`);
    assert.ok(operations.includes('chat'), `Missing inference span: ${JSON.stringify(operations)}`);
    console.log(JSON.stringify({ modelCalls, operations }));
  } finally {
    instrumentor.disable();
    await modelProvider.close();
    await provider.shutdown();
    await ObservabilityManager.shutdown();
    contextManager.disable();
    context.disable();
    trace.disable();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
