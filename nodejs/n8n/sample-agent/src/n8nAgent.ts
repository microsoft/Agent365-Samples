// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { AgentNotificationActivity, NotificationType, createAgentNotificationActivity } from '@microsoft/agents-a365-notifications';
import { AgentApplication, TurnContext, TurnState } from '@microsoft/agents-hosting';
import { N8nClient } from './n8nClient';
import { McpToolRegistrationService, McpServer } from './mcpToolRegistrationService';

export class N8nAgent {
  static authHandlerName: string = 'agentic';
  toolService: McpToolRegistrationService = new McpToolRegistrationService();
  agentApplication: AgentApplication<TurnState>;

  constructor(agentApplication: AgentApplication<TurnState>) {
    this.agentApplication = agentApplication;
  }

  /**
   * Handles incoming user messages and sends responses using n8n.
   */
  async handleAgentMessageActivity(turnContext: TurnContext, state: TurnState): Promise<void> {
    const userMessage = turnContext.activity.text?.trim() || '';
    const fromUser = turnContext.activity.from?.name || '';

    if (!userMessage) {
      await turnContext.sendActivity('Please send me a message and I\'ll help you!');
      return;
    }

    try {
      const n8nClient = await this.getN8nClient(turnContext);
      const response = await n8nClient.invokeAgentWithScope(userMessage, fromUser);
      await turnContext.sendActivity(response);
    } catch (error) {
      console.error('n8n query error:', error);
      const err = error as any;
      await turnContext.sendActivity(`Error: ${err.message || err}`);
    }
  }

  /**
   * Handles agent notification activities by parsing the activity type.
   */
  async handleAgentNotificationActivity(turnContext: TurnContext, state: TurnState): Promise<void> {
    try {
      const activity = turnContext.activity;
      if (!activity || !Array.isArray(activity.entities)) {
        await turnContext.sendActivity('No activity entities found.');
        return;
      }

      // Find the first known notification type entity
      const agentNotificationActivity = createAgentNotificationActivity(activity);

      switch (agentNotificationActivity.notificationType) {
        case NotificationType.EmailNotification:
          await this.emailNotificationHandler(turnContext, state, agentNotificationActivity);
          break;
        case NotificationType.WpxComment:
          await this.wordNotificationHandler(turnContext, state, agentNotificationActivity);
          break;
        default:
          await turnContext.sendActivity('Notification type not yet implemented.');
      }
    } catch (error) {
      console.error('Error handling agent notification activity:', error);
      const err = error as any;
      await turnContext.sendActivity(`Error handling notification: ${err.message || err}`);
    }
  }

  /**
   * Handles agent installation and removal events.
   */
  async handleInstallationUpdateActivity(turnContext: TurnContext, state: TurnState): Promise<void> {
    if (turnContext.activity.action === 'add') {
      await turnContext.sendActivity('Thank you for hiring me! Looking forward to assisting you in your professional journey! Before I begin, could you please confirm that you accept the terms and conditions? Send "I accept" to accept.');
    } else if (turnContext.activity.action === 'remove') {
      await turnContext.sendActivity('Thank you for your time, I enjoyed working with you.');
    }
  }

  /**
   * Handles @-mention notification activities.
   */
  async wordNotificationHandler(turnContext: TurnContext, state: TurnState, mentionActivity: AgentNotificationActivity): Promise<void> {
    await turnContext.sendActivity('Thanks for the @-mention notification! Working on a response...');
    const mentionNotificationEntity = mentionActivity.wpxCommentNotification;

    if (!mentionNotificationEntity) {
      await turnContext.sendActivity('I could not find the mention notification details.');
      return;
    }

    const documentId = mentionNotificationEntity.documentId;
    const odataId = mentionNotificationEntity["odata.id"];
    const initiatingCommentId = mentionNotificationEntity.initiatingCommentId;
    const subjectCommentId = mentionNotificationEntity.subjectCommentId;

    let mentionPrompt = `You have been mentioned in a Word document.
      Document ID: ${documentId || 'N/A'}
      OData ID: ${odataId || 'N/A'}
      Initiating Comment ID: ${initiatingCommentId || 'N/A'}
      Subject Comment ID: ${subjectCommentId || 'N/A'}
      Please retrieve the text of the initiating comment and return it in plain text.`;

    const n8nClient = await this.getN8nClient(turnContext);
    const commentContent = await n8nClient.invokeAgentWithScope(mentionPrompt);
    const response = await n8nClient.invokeAgentWithScope(
      `You have received the following comment. Please follow any instructions in it. ${commentContent}`
    );
    await turnContext.sendActivity(response);
  }

  /**
   * Handles email notification activities.
   */
  async emailNotificationHandler(turnContext: TurnContext, state: TurnState, emailActivity: AgentNotificationActivity): Promise<void> {
    await turnContext.sendActivity('Thanks for the email notification! Working on a response...');
    const emailNotificationEntity = emailActivity.emailNotification;

    if (!emailNotificationEntity) {
      await turnContext.sendActivity('I could not find the email notification details.');
      return;
    }

    const emailNotificationId = emailNotificationEntity.id;
    const emailNotificationConversationId = emailNotificationEntity.conversationId;
    const emailNotificationConversationIndex = emailNotificationEntity.conversationIndex;
    const emailNotificationChangeKey = emailNotificationEntity.changeKey;

    const n8nClient = await this.getN8nClient(turnContext);
    const emailContent = await n8nClient.invokeAgentWithScope(
      `You have a new email from ${turnContext.activity.from?.name} with id '${emailNotificationId}',
      ConversationId '${emailNotificationConversationId}', ConversationIndex '${emailNotificationConversationIndex}',
      and ChangeKey '${emailNotificationChangeKey}'. Please retrieve this message and return it in text format.`
    );

    const response = await n8nClient.invokeAgentWithScope(
      `You have received the following email. Please follow any instructions in it. ${emailContent}`
    );

    await turnContext.sendActivity(response);
  }

  async getN8nClient(turnContext: TurnContext): Promise<N8nClient> {
    const mcpServers: McpServer[] = [];
    try {
      mcpServers.push(...await this.toolService.getMcpServers(
        N8nAgent.authHandlerName,
        turnContext,
        this.agentApplication,
        process.env.MCP_AUTH_TOKEN || ""
      ));
    } catch (error) {
      console.warn('Failed to register MCP tool servers:', error);
    }

    return new N8nClient(mcpServers);
  }
}
