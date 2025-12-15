// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TurnState, AgentApplicationBuilder, MemoryStorage, TurnContext } from '@microsoft/agents-hosting';
import { ActivityTypes } from '@microsoft/agents-activity';
import { N8nAgent } from './n8nAgent';

const storage = new MemoryStorage();

export const agentApplication =
  new AgentApplicationBuilder<TurnState>()
    .withAuthorization({ agentic: {} })
    .withStorage(storage)
    .build();

const n8nAgent = new N8nAgent(agentApplication);

agentApplication.onActivity(ActivityTypes.Message, async (context: TurnContext, state: TurnState) => {
  await n8nAgent.handleAgentMessageActivity(context, state);
});

agentApplication.onActivity(ActivityTypes.InstallationUpdate, async (context: TurnContext, state: TurnState) => {
  await n8nAgent.handleInstallationUpdateActivity(context, state);
});
