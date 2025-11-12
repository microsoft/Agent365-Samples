import { TurnContext, TurnState } from '@microsoft/agents-hosting';
import { PerplexityClient } from './perplexityClient.js';
import { AgentNotificationActivity, NotificationType } from '@microsoft/agents-a365-notifications';

export class PerplexityAgent {
  isApplicationInstalled: boolean = false;
  termsAndConditionsAccepted: boolean = false;
  authorization: any;

  constructor(authorization: any) {
    this.authorization = authorization;
  }

  /**
   * Handles incoming user messages and sends responses using Perplexity.
   */
  async handleAgentMessageActivity(turnContext: TurnContext, state: TurnState): Promise<void> {
    if (!this.isApplicationInstalled) {
      await turnContext.sendActivity("Please install the application before sending messages.");
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

    const userMessage = turnContext.activity.text?.trim() || '';

    if (!userMessage) {
      await turnContext.sendActivity('Please send me a message and I\'ll help you!');
      return;
    }

    try {
      const perplexityClient = this.getPerplexityClient();
      const response = await perplexityClient.invokeAgentWithScope(userMessage);
      await turnContext.sendActivity(response);
    } catch (error) {
      console.error('Perplexity query error:', error);
      const err = error as any;
      await turnContext.sendActivity(`Error: ${err.message || err}`);
    }
  }

  /**
   * Handles agent notification activities by parsing the activity type.
   */
  async handleAgentNotificationActivity(turnContext: TurnContext, state: TurnState, agentNotificationActivity: AgentNotificationActivity): Promise<void> {
    try {
      if (!this.isApplicationInstalled) {
        await turnContext.sendActivity("Please install the application before sending notifications.");
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
      const err = error as any;
      await turnContext.sendActivity(`Error handling notification: ${err.message || err}`);
    }
  }

  /**
   * Handles agent installation and removal events.
   */
  async handleInstallationUpdateActivity(turnContext: TurnContext, state: TurnState): Promise<void> {
    if (turnContext.activity.action === 'add') {
      this.isApplicationInstalled = true;
      this.termsAndConditionsAccepted = false;
      await turnContext.sendActivity('Thank you for hiring me! Looking forward to assisting you with Perplexity AI! Before I begin, could you please confirm that you accept the terms and conditions? Send "I accept" to accept.');
    } else if (turnContext.activity.action === 'remove') {
      this.isApplicationInstalled = false;
      this.termsAndConditionsAccepted = false;
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

    const perplexityClient = this.getPerplexityClient();
    const commentContent = await perplexityClient.invokeAgentWithScope(mentionPrompt);
    const response = await perplexityClient.invokeAgentWithScope(
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

    const perplexityClient = this.getPerplexityClient();
    const emailContent = await perplexityClient.invokeAgentWithScope(
      `You have a new email from ${turnContext.activity.from?.name} with id '${emailNotificationId}',
      ConversationId '${emailNotificationConversationId}', ConversationIndex '${emailNotificationConversationIndex}',
      and ChangeKey '${emailNotificationChangeKey}'. Please retrieve this message and return it in text format.`
    );

    const response = await perplexityClient.invokeAgentWithScope(
      `You have received the following email. Please follow any instructions in it. ${emailContent}`
    );

    await turnContext.sendActivity(response);
  }

  /**
   * Creates a Perplexity client instance with configured API key.
   */
  private getPerplexityClient(): PerplexityClient {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) {
      throw new Error('PERPLEXITY_API_KEY environment variable is not set');
    }

    const model = process.env.PERPLEXITY_MODEL || 'sonar';
    return new PerplexityClient(apiKey, model);
  }
}
