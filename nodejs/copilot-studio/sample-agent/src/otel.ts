// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { configDotenv } from "dotenv";
import {
  Agent365ExporterOptions,
  ObservabilityManager,
} from "@microsoft/agents-a365-observability";
import { RuntimeConfiguration } from "@microsoft/agents-a365-runtime";
import { createObservabilityTokenResolver } from "./observability-token-service";

configDotenv();

// Legacy per-request export bypasses the resolver and reads a context token.
if (RuntimeConfiguration.parseEnvBoolean(
  process.env["ENABLE_A365_OBSERVABILITY_PER_REQUEST_EXPORT"],
)) {
  throw new Error("Disable ENABLE_A365_OBSERVABILITY_PER_REQUEST_EXPORT: OBS requires the app-only resolver.");
}

const observability = ObservabilityManager.configure((builder) => {
  const exporterOptions = new Agent365ExporterOptions();
  exporterOptions.maxQueueSize = 10;
  // preview.115 selects the legacy service route, without an /otlp segment.
  exporterOptions.useS2SEndpoint = true;

  builder
    .withService("Copilot Studio Sample Agent", "1.0.0")
    .withExporterOptions(exporterOptions)
    .withTokenResolver(createObservabilityTokenResolver());
});

observability.start();
