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
const envFile = process.env.AGENT_ENV_FILE;
const envResult = configDotenv({ path: envFile || '.env' });
if (envFile && envResult.error) throw envResult.error;
if (envFile) configDotenv({ path: 'env/.env.playground' });

// A365 Observability — best-effort instrumentation (verify against official sample)
import { useMicrosoftOpenTelemetry, configureA365Hosting } from '@microsoft/opentelemetry';
import type { CloudAdapter } from '@microsoft/agents-hosting';
import { createAppTokenResolver, type ConnectionProvider } from './observability/app-token-resolver';
import { toObservabilityContext } from './observability/turn-context';

let getObsConnection: ConnectionProvider | undefined;
const appTokenResolver = createAppTokenResolver(() => {
  if (!getObsConnection) throw new Error('Observability hosting connection is not initialized.');
  return getObsConnection();
});

// Console exporters are useful for local development but noisy and potentially
// sensitive (gen-ai content) in production. Enable only outside production.
const enableConsoleExporters =
  process.env.NODE_ENV !== 'production' && !process.env.WEBSITE_SITE_NAME;

const enableObservability = process.env.ENABLE_OBSERVABILITY !== 'false';

export function configureObservabilityHosting(adapter: CloudAdapter): void {
  getObsConnection = () => adapter.connectionManager.getDefaultConnection();
  if (enableObservability) {
    configureA365Hosting({
      use: (...middlewares) => {
        for (const middleware of middlewares) {
          adapter.use({
            onTurn: (context, next) => middleware.onTurn(toObservabilityContext(context), next),
          });
        }
      },
    }, { enableBaggage: true, enableOutputLogging: false });
  }
}

if (enableObservability) {
  useMicrosoftOpenTelemetry({
    enableConsoleExporters,
    azureMonitor: {
      enabled: Boolean(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING),
    },
    a365: {
      enabled: true,
      enableObservabilityExporter: process.env.ENABLE_A365_OBSERVABILITY_EXPORTER === 'true',
      useS2SEndpoint: true,
      tokenResolver: appTokenResolver,
      durableDelivery: { enabled: false },
    },
    instrumentationOptions: {
      http: { enabled: true },
    },
  });

  console.log(
    `Observability configured via Microsoft OpenTelemetry Distro ` +
      `(enable_a365=true, token_resolver=app-only, ` +
      `a365_exporter=${process.env.ENABLE_A365_OBSERVABILITY_EXPORTER === 'true'})`
  );
} else {
  console.log('Observability disabled (ENABLE_OBSERVABILITY=false)');
}
