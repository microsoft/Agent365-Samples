import {
  ObservabilityManager,
  Builder,
} from '@microsoft/agents-a365-observability';

export const observabilityManager = ObservabilityManager.configure(
  (builder) =>
    builder
      .withService('TypeScript Sample Agent', '1.0.0')
);

