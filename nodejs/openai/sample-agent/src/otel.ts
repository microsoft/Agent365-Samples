// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { configDotenv } from 'dotenv';
import { Agent365ExporterOptions, ObservabilityManager } from '@microsoft/agents-a365-observability';
import { OpenAIAgentsTraceInstrumentor } from '@microsoft/agents-a365-observability-extensions-openai';
import { RuntimeConfiguration } from '@microsoft/agents-a365-runtime';
import { createObservabilityTokenResolver } from './observability-token-service';

configDotenv();
// Per-request export reads a context token instead of the dedicated resolver.
if (RuntimeConfiguration.parseEnvBoolean(process.env.ENABLE_A365_OBSERVABILITY_PER_REQUEST_EXPORT)) {
  throw new Error('Disable ENABLE_A365_OBSERVABILITY_PER_REQUEST_EXPORT: OBS requires the app-only resolver.');
}

const observability = ObservabilityManager.configure((builder) => {
  const options = new Agent365ExporterOptions();
  options.useS2SEndpoint = true;
  options.maxQueueSize = 10;
  builder
    .withService('OpenAI Sample Agent', '1.0.0')
    .withExporterOptions(options)
    .withTokenResolver(createObservabilityTokenResolver());
});

observability.start();
new OpenAIAgentsTraceInstrumentor({
  enabled: true, tracerName: 'openai-agent-auto-instrumentation',
}).enable();
