import {
  ObservabilityManager,
  Builder,
} from '@microsoft/agents-a365-observability';

export const kairo = ObservabilityManager.configure(
  (builder: Builder) =>
    builder
      .withService('Perplexity Agent', '1.0.0')
);
