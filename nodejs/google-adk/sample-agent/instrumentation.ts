// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * OpenTelemetry instrumentation setup.
 *
 * IMPORTANT: This file MUST be imported before any other application modules
 * so that the OpenTelemetry SDK can patch libraries (HTTP, etc.) before they are loaded.
 *
 * dotenv MUST be loaded here (before @microsoft/opentelemetry) so that
 * A365_OBSERVABILITY_LOG_LEVEL is available when the logging module initializes.
 */

import { configDotenv } from 'dotenv';
configDotenv();

import { useMicrosoftOpenTelemetry, AgenticTokenCacheInstance, Agent365Exporter } from '@microsoft/opentelemetry';

// Console exporters are useful for local development but noisy and potentially
// sensitive (gen-ai content) in production. Enable only outside production.
const enableConsoleExporters =
  process.env.NODE_ENV !== 'production' && !process.env.WEBSITE_SITE_NAME;

const enableObservability = process.env.ENABLE_OBSERVABILITY !== 'false';

if (enableObservability) {
  // Patch Agent365Exporter.postWithRetries to log the HTTP response body
  // (like the Python distro does). The Node.js distro discards it by default.
  const proto = Agent365Exporter.prototype as any;
  const originalPostWithRetries = proto.postWithRetries;
  proto.postWithRetries = async function (url: string, body: Uint8Array, headers: Record<string, string>) {
    const originalFetch = globalThis.fetch;
    let attempt = 0;
    const self = this;
    globalThis.fetch = async (input: any, init?: any) => {
      attempt++;
      const response: Response = await originalFetch(input, init);
      const cloned = response.clone();
      try {
        const correlationId =
          response.headers.get('x-ms-correlation-id') ??
          response.headers.get('x-correlation-id') ??
          'unknown';
        const text = await cloned.text();
        console.log(
          `${new Date().toISOString()} INFO [Agent365Exporter] HTTP ${response.status} ` +
          `${response.ok ? 'success' : 'FAILED'} on attempt ${attempt}. ` +
          `Correlation ID: ${correlationId}. Response: ${text}`
        );
      } catch {
        // Non-critical
      }
      return response;
    };
    try {
      return await originalPostWithRetries.call(self, url, body, headers);
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  useMicrosoftOpenTelemetry({
    enableConsoleExporters,
    azureMonitor: {
      enabled: Boolean(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING),
    },
    a365: {
      enabled: true,
      tokenResolver: (agentId: string, tenantId: string) =>
        AgenticTokenCacheInstance.getObservabilityToken(agentId, tenantId) ?? '',
    },
    instrumentationOptions: {
      http: { enabled: true },
    },
  });

  console.log(
    `Observability configured via Microsoft OpenTelemetry Distro ` +
      `(enable_a365=true, token_resolver=AgenticTokenCacheInstance, ` +
      `a365_exporter=${process.env.ENABLE_A365_OBSERVABILITY_EXPORTER ?? 'true'})`
  );
} else {
  console.log('Observability disabled (ENABLE_OBSERVABILITY=false)');
}
