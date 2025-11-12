import {
  ObservabilityManager,
} from '@microsoft/agents-a365-observability';

export const observabilityManager = ObservabilityManager.configure(
  (builder) =>
    builder
      .withService('n8n Sample Agent', '1.0.0')
);

