// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  ObservabilityManager,
  Builder,
  Agent365ExporterOptions,
} from '@microsoft/agents-a365-observability';
import { AgenticTokenCacheInstance } from '@microsoft/agents-a365-observability-hosting';

/**
 * Initializes A365 observability for a service process.
 * Call once at service startup before any tracing operations.
 */
export function initializeObservability(serviceName: string): void {
  const observability = ObservabilityManager.configure((builder: Builder) => {
    const exporterOptions = new Agent365ExporterOptions();
    exporterOptions.maxQueueSize = 10;

    builder
      .withService(serviceName, '1.0.0')
      .withExporterOptions(exporterOptions)
      .withTokenResolver((agentId: string, tenantId: string) =>
        AgenticTokenCacheInstance.getObservabilityToken(agentId, tenantId)
      );
  });

  observability.start();
}
