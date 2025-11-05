
import { createClaudeResponseCard, createErrorCard } from './adaptiveCards.js'
import { MessageFactory } from "@microsoft/agents-hosting"
import { ClaudeClient } from './claudeClient.js';
import { McpToolRegistrationService } from '@microsoft/agents-a365-tooling-extensions-claude'
import { NotificationType } from '@microsoft/agents-a365-notifications';

// When running in debug mode, these variables can interfere with Claude's child
// processes
const cleanEnv = { ...process.env };
delete cleanEnv.NODE_OPTIONS;
delete cleanEnv.VSCODE_INSPECTOR_OPTIONS;

/**
 * ClaudeClient provides an interface to interact with the Claude Code SDK.
 * It maintains agentOptions as an instance field and exposes an invokeAgent method.
 */
export class ClaudeAgent {
  /**
   * Indicates if the application is installed (installation update state).
   */
  isApplicationInstalled = false;

  /**
   * Indicates if the user has accepted terms and conditions.
   */
  termsAndConditionsAccepted = false;

  toolServerService = new McpToolRegistrationService()

  /**
   * @param {object} agentOptions - Configuration for the Claude agent (tooling, system prompt, etc).
   */
  constructor(authorization) {
    this.authorization = authorization
  }

  /**
   * Handles incoming user messages, streams progress, and sends adaptive card responses using Claude.
   * Manages feedback, sensitivity labels, and error handling for conversational activities.
   */
  async handleAgentMessageActivity(turnContext, state) {
    // Set up streaming response
    turnContext.streamingResponse.setFeedbackLoop(true)
    turnContext.streamingResponse.setSensitivityLabel({
      type: 'https://schema.org/Message',
      '@type': 'CreativeWork',
      name: 'Internal'
    })
    turnContext.streamingResponse.setGeneratedByAILabel(true)

    if (!this.isApplicationInstalled) {
      await turnContext.sendActivity(MessageFactory.Text("Please install the application before sending messages."));
      return;
    }

    if (!this.termsAndConditionsAccepted) {
      if (turnContext.activity.text?.trim().toLowerCase() === "i accept") {
        this.termsAndConditionsAccepted = true;
        await turnContext.sendActivity("Thank you for accepting the terms and conditions! How can I assist you today?");
        return;
      } else {
        await turnContext.sendActivity("Please accept the terms and conditions to proceed. Send 'I accept' to accept.");
        return;
      }
    }

    const userMessage = turnContext.activity.text?.trim() || ''

    if (!userMessage) {
      await turnContext.streamingResponse.queueTextChunk('Please send me a message and I\'ll help you!')
      await turnContext.streamingResponse.endStream()
      return
    }

    try {
      // Show processing indicator
      await turnContext.streamingResponse.queueInformativeUpdate('🤔 Thinking with Claude...')

      const claudeClient = await this.getClaudeClient(turnContext)

      // Use Claude Code SDK to process the user's request
      const claudeResponse = await claudeClient.invokeAgentWithScope(userMessage)

      // End streaming and send adaptive card response
      await turnContext.streamingResponse.endStream()

      // Create and send adaptive card with Claude's response
      const responseCard = createClaudeResponseCard(claudeResponse, userMessage)

      const cardAttachment = MessageFactory.attachment({
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: responseCard
      })

      await turnContext.sendActivity(cardAttachment)
    } catch (error) {
      console.error('Claude query error:', error)

      // End streaming first
      await turnContext.streamingResponse.endStream()

      // Send error as adaptive card
      const errorCard = createErrorCard(error, userMessage)
      const errorAttachment = MessageFactory.attachment({
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: errorCard
      })

      await turnContext.sendActivity(errorAttachment)
    }
  }

  /**
   * Handles agent notification activities by parsing the activity type.
   * Supports:
   * - Email notifications
   * - @-mentions from Word and Excel
   * - Agent on-boarding and off-boarding activities
   *
   * @param {object} turnContext - The context object for the current turn.
   * @param {object} state - The state object for the current turn.
   * @param {object} agentNotificationActivity - The incoming activity to handle.
   */
  async handleAgentNotificationActivity(turnContext, state, agentNotificationActivity) {
    try {
      if (!this.isApplicationInstalled) {
        await turnContext.sendActivity(MessageFactory.Text("Please install the application before sending notifications."));
        return;
      }

      if (!this.termsAndConditionsAccepted) {
        if (turnContext.activity.text?.trim().toLowerCase() === "i accept") {
          this.termsAndConditionsAccepted = true;
          await turnContext.sendActivity("Thank you for accepting the terms and conditions! How can I assist you today?");
          return;
        } else {
          await turnContext.sendActivity("Please accept the terms and conditions to proceed. Send 'I accept' to accept.");
          return;
        }
      }

      // Find the first known notification type entity

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
      await turnContext.sendActivity(`Error handling notification: ${error.message || error}`);
    }
  }

  /**
   * Handles agent installation and removal events, updating internal state and prompting for terms acceptance.
   * Sends a welcome or farewell message based on the activity action.
   */
  async handleInstallationUpdateActivity(turnContext, state) {
    if (turnContext.activity.action === 'add') {
      this.isApplicationInstalled = true;
      this.termsAndConditionsAccepted = false;
      await turnContext.sendActivity('Thank you for hiring me! Looking forward to assisting you in your professional journey! Before I begin, could you please confirm that you accept the terms and conditions? Send "I accept" to accept.');
    } else if (turnContext.activity.action === 'remove') {
      this.isApplicationInstalled = false;
      this.termsAndConditionsAccepted = false;
      await turnContext.sendActivity('Thank you for your time, I enjoyed working with you.');
    }
  }

  /**
   * Handles @-mention notification activities.
   * @param {object} turnContext - The context object for the current turn.
   * @param {object} mentionNotificationEntity - The mention notification entity.
   */
  async wordNotificationHandler(turnContext, state, wordActivity) {
    await turnContext.sendActivity('Thanks for the @-mention notification! Working on a response...');
    const mentionNotificationEntity = wordActivity.wpxCommentNotification;

    if (!mentionNotificationEntity) {
      await turnContext.sendActivity('I could not find the mention notification details.');
      return;
    }

    // Use correct fields from mentionActivity.json
    const documentId = mentionNotificationEntity.documentId;
    const odataId = mentionNotificationEntity["odata.id"];
    const initiatingCommentId = mentionNotificationEntity.initiatingCommentId;
    const subjectCommentId = mentionNotificationEntity.subjectCommentId;

    let mentionPrompt =
      `You have been mentioned in a Word document.
      Document ID: ${documentId || 'N/A'}
      OData ID: ${odataId || 'N/A'}
      Initiating Comment ID: ${initiatingCommentId || 'N/A'}
      Subject Comment ID: ${subjectCommentId || 'N/A'}
      Please retrieve the text of the initiating comment and return it in plain text.`;

    const claudeClient = await this.getClaudeClient(turnContext);
    const commentContent = await claudeClient.invokeAgentWithScope(mentionPrompt);

    const response = await claudeClient.invokeAgentWithScope(
      `You have received the following comment. Please follow any instructions in it. ${commentContent.content}`
    );

    await turnContext.sendActivity(response);
    return;
  }

  /**
   * Handles email notification activities.
   * @param {object} turnContext - The context object for the current turn.
   * @param {object} emailNotificationEntity - The email notification entity.
   */
  async emailNotificationHandler(turnContext, state, emailActivity) {
    await turnContext.sendActivity('Thanks for the email notification! Working on a response...');

    const emailNotificationEntity = emailActivity.emailNotification;
    if (!emailNotificationEntity) {
      await turnContext.sendActivity('I could not find the email notification details.');
      return;
    }

    const emailNotificationId = emailNotificationEntity.Id;
    const emailNotificationConversationId = emailNotificationEntity.conversationId;
    const emailNotificationConversationIndex = emailNotificationEntity.conversationIndex;
    const emailNotificationChangeKey = emailNotificationEntity.changeKey;

    const claudeClient = await this.getClaudeClient(turnContext);
    const emailContent = await claudeClient.invokeAgentWithScope(
      `You have a new email from ${turnContext.activity.from?.name} with id '${emailNotificationId}',
      ConversationId '${emailNotificationConversationId}', ConversationIndex '${emailNotificationConversationIndex}',
      and ChangeKey '${emailNotificationChangeKey}'. Please retrieve this message and return it in text format.`
    );

    const response = await claudeClient.invokeAgentWithScope(
      `You have received the following email. Please follow any instructions in it. ${emailContent.content}`
    );

    await turnContext.sendActivity(response);
    return;
  }

  async getClaudeClient(turnContext) {
    const agentOptions = {
      appendSystemPrompt: `You are a helpful AI assistant integrated with Microsoft 365.`,
      maxTurns: 3,
      allowedTools: ['Read', 'Write', 'WebSearch', 'Bash', 'Grep'],
      env: {
        ...cleanEnv
      },
    }

    const mcpEnvironmentId = process.env.MCP_ENVIRONMENT_ID || '';
    const agenticUserId = process.env.AGENTIC_USER_ID || '';
    const mcpAuthToken = process.env.MCP_AUTH_TOKEN || '';

    if (mcpEnvironmentId && agenticUserId) {
      try {

          await this.toolServerService.addToolServers(
          agentOptions,
          agenticUserId,
          mcpEnvironmentId,
          this.authorization,
          turnContext,
          mcpAuthToken
        )
      } catch (error) {
        console.warn('Failed to register MCP tool servers:', error.message);
      }
    } else {
      console.log('MCP configuration not provided, using basic Claude agent functionality');
    }

    return new ClaudeClient(agentOptions)
  }
}