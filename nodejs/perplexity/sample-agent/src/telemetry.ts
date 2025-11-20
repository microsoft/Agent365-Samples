// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  ObservabilityManager,
  Builder,
  Agent365ExporterOptions,
} from "@microsoft/agents-a365-observability";
import { getClusterCategory, tokenResolver } from "./telemetryHelpers.js";
import { AgenticTokenCacheInstance } from "@microsoft/agents-a365-observability-tokencache";

export const a365Observability = ObservabilityManager.configure(
  (builder: Builder) => {
    const exporterOptions = new Agent365ExporterOptions();
    exporterOptions.maxQueueSize = 10; // customized per request

    builder
      .withService("TypeScript Sample Agent", "1.0.0")
      .withClusterCategory(getClusterCategory())
      .withExporterOptions(exporterOptions);
    // Opt-in custom token resolver via env flag `Use_Custom_Resolver=true`
    if (process.env.Use_Custom_Resolver === "true") {
      builder.withTokenResolver(tokenResolver);
    } else {
      // use resolver from observability token cache package
      builder.withTokenResolver((agentId: string, tenantId: string) =>
        AgenticTokenCacheInstance.getObservabilityToken(agentId, tenantId)
      );
    }
  }
);
