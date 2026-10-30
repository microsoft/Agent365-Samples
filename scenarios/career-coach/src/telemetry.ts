// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// A365 Observability — best-effort instrumentation (verify against official sample)
// Must be imported BEFORE any module that loads @openai/agents so the distro's
// OpenAI Agents auto-instrumentation can patch it (see index.ts import order).
import { configDotenv } from 'dotenv';
configDotenv();

import { useMicrosoftOpenTelemetry } from '@microsoft/opentelemetry';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { createAppTokenResolver, type ConnectionProvider } from './observability/app-token-resolver';

// The adapter is created after observability init (by agent.ts), so the resolver reads its
// connection lazily. index.ts hands it over via setObservabilityConnection().
let getObsConnection: ConnectionProvider | undefined;
export function setObservabilityConnection(provider: ConnectionProvider): void {
  getObsConnection = provider;
}
const appTokenResolver = createAppTokenResolver(() => {
  if (!getObsConnection) throw new Error('Adapter is not initialised yet.');
  return getObsConnection();
});

useMicrosoftOpenTelemetry({
  enableConsoleExporters: process.env.NODE_ENV !== 'production' && !process.env.WEBSITE_SITE_NAME,
  resource: resourceFromAttributes({
    'service.name': process.env.SERVICE_NAME ?? 'Employee Career Coach',
    'service.version': '1.0.0',
  }),
  a365: {
    // BOTH flags are required for spans to reach the A365 backend:
    //   enabled → A365SpanProcessor (enrichment); enableObservabilityExporter → Agent365Exporter (export).
    // The exporter is on unless ENABLE_A365_OBSERVABILITY_EXPORTER is explicitly "false" (local dev).
    enabled: true,
    enableObservabilityExporter: process.env.ENABLE_A365_OBSERVABILITY_EXPORTER !== 'false',
    // Every auth mode exports over the S2S route with an app-only token for the exporting
    // agent identity. The S2S route rejects delegated (OBO / Agentic User) tokens.
    useS2SEndpoint: true,
    tokenResolver: appTokenResolver,
  },
  // OpenAI Agents SDK auto-instrumentation is ON by default — do not call a manual instrumentor.
});
