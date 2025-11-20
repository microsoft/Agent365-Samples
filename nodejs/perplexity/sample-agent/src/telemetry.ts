// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  ObservabilityManager,
  Builder,
} from "@microsoft/agents-a365-observability";
import { getClusterCategory, tokenResolver } from "./telemetryHelpers.js";

export const a365Observability = ObservabilityManager.configure(
  (builder: Builder) => {
    builder
      .withService("Perplexity Agent", "1.0.0")
      .withClusterCategory(getClusterCategory())
      .withTokenResolver(tokenResolver);
  }
);
