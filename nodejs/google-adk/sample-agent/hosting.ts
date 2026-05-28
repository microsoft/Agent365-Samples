// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  AgentApplication,
  TurnContext,
  TurnState,
  MemoryStorage,
  CloudAdapter,
  getAuthConfigWithDefaults,
} from '@microsoft/agents-hosting';
import { Activity, ActivityTypes } from '@microsoft/agents-activity';
import '@microsoft/agents-a365-notifications';
import {
  AgentNotificationActivity,
  createEmailResponseActivity,
  NotificationType,
} from '@microsoft/agents-a365-notifications';
import {
  BaggageBuilder,
  BaggageBuilderUtils,
  AgenticTokenCacheInstance,
} from '@microsoft/opentelemetry';

import type { AgentInterface } from './agentInterface';

const logger = {
  info: (...args: unknown[]) => console.log(new Date().toISOString(), 'INFO', 'MyAgent:', ...args),
  warn: (...args: unknown[]) => console.warn(new Date().toISOString(), 'WARN', 'MyAgent:', ...args),
  error: (...args: unknown[]) => console.error(new Date().toISOString(), 'ERROR', 'MyAgent:', ...args),
};

// Auth handler name — set to "agentic" for production agentic auth
const AUTH_HANDLER_NAME = 'agentic';

export class MyAgent extends AgentApplication<TurnState> {
  public agent: AgentInterface;
  private myAdapter: CloudAdapter;

  get cloudAdapter(): CloudAdapter {
    return this.myAdapter;
  }

  constructor(agent: AgentInterface) {
    const storage = new MemoryStorage();
    const authConfig = getAuthConfigWithDefaults();
    const adapter = new CloudAdapter(authConfig);

    const useAgenticAuth = process.env.USE_AGENTIC_AUTH === 'true' ||
      process.env.AUTH_HANDLER_NAME === 'AGENTIC' ||
      process.env.AUTH_HANDLER_NAME === 'agentic';

    super({
      storage,
      adapter,
      ...(useAgenticAuth && {
        authorization: {
          [AUTH_HANDLER_NAME]: {
            type: 'agentic',
          },
        },
      }),
    });

    this.myAdapter = adapter;
    this.agent = agent;

    if (useAgenticAuth) {
      logger.info(`Auth handler: ${AUTH_HANDLER_NAME} (agentic authorization enabled)`);
    } else {
      logger.info('No auth handler configured — anonymous mode (Playground/local dev)');
    }

    this.setupHandlers(useAgenticAuth);
    logger.info('Handlers registered successfully');
  }

  // -- observability -------------------------------------------------------

  /**
   * Preloads or refreshes the Observability token used by the Agent 365
   * Observability exporter. Uses AgenticTokenCacheInstance.refreshObservabilityToken()
   * which handles OBO token acquisition automatically.
   */
  private async preloadObservabilityToken(turnContext: TurnContext): Promise<void> {
    const agentId = turnContext?.activity?.recipient?.agenticAppId ?? '';
    const tenantId = (turnContext?.activity?.recipient as any)?.tenantId ?? '';

    logger.info(`Observability token refresh — agentId: '${agentId}', tenantId: '${tenantId}'`);

    try {
      await AgenticTokenCacheInstance.refreshObservabilityToken(
        agentId,
        tenantId,
        turnContext as any,
        this.authorization as any
      );
      logger.info('Observability token refreshed successfully');
    } catch (err) {
      logger.warn('Failed to refresh observability token:', err);
    }
  }

  // -- handler registration ------------------------------------------------

  private setupHandlers(useAgenticAuth: boolean): void {
    const authHandlerName = useAgenticAuth ? AUTH_HANDLER_NAME : null;

    // --- Installation Update (hire / remove) ---
    this.onActivity(ActivityTypes.InstallationUpdate, async (context: TurnContext, _state: TurnState) => {
      const action = context.activity.action;
      const fromProp = context.activity.from;
      logger.info(
        `InstallationUpdate — Action: '${action ?? '(none)'}', ` +
          `DisplayName: '${fromProp?.name ?? '(unknown)'}', ` +
          `UserId: '${fromProp?.id ?? '(unknown)'}'`
      );
      if (action === 'add') {
        await context.sendActivity(
          'Thank you for hiring me! Looking forward to assisting you in your professional journey!'
        );
      } else if (action === 'remove') {
        await context.sendActivity(
          'Thank you for your time, I enjoyed working with you.'
        );
      }
    });

    // --- Direct messages ---
    this.onActivity(
      ActivityTypes.Message,
      async (context: TurnContext, _state: TurnState) => {
        const from = context.activity?.from;
        logger.info(
          `Turn received from user — DisplayName: '${from?.name ?? '(unknown)'}', ` +
            `UserId: '${from?.id ?? '(unknown)'}', AadObjectId: '${from?.aadObjectId ?? '(none)'}'`
        );
        const displayName = from?.name ?? 'unknown';

        const userMessage = context.activity.text?.trim() || '';
        if (!userMessage) {
          await context.sendActivity("Please send me a message and I'll help you!");
          return;
        }

        // Multiple messages pattern: immediate ack
        await context.sendActivity('Got it — working on it…');
        await context.sendActivity({ type: 'typing' } as Activity);

        // Typing indicator loop — refreshes the "..." animation every ~4s
        let typingInterval: ReturnType<typeof setInterval> | undefined;
        const startTypingLoop = () => {
          typingInterval = setInterval(() => {
            context.sendActivity({ type: 'typing' } as Activity).catch(() => {});
          }, 4000);
        };
        const stopTypingLoop = () => { clearInterval(typingInterval); };

        // Build baggage from TurnContext — auto-populates tenant, agent, channel, conversation
        const baggageScope = BaggageBuilderUtils.fromTurnContext(
          new BaggageBuilder(),
          context as any
        ).build();

        // Preload/refresh exporter token
        await this.preloadObservabilityToken(context);

        startTypingLoop();

        try {
          await baggageScope.run(async () => {
            try {
              const response = await this.agent.invokeAgentWithScope(
                userMessage,
                this.authorization,
                authHandlerName,
                context
              );
              await context.sendActivity(response);
            } catch (error) {
              logger.error('LLM query error:', error);
              const err = error as any;
              await context.sendActivity(`Error: ${err.message || err}`);
            }
          });
        } finally {
          stopTypingLoop();
          baggageScope.dispose();
        }
      }
    );

    // --- Agent notifications (email, Word comments, lifecycle) ---
    this.onAgentNotification(
      'agents:*',
      async (context: TurnContext, _state: TurnState, agentNotificationActivity: AgentNotificationActivity) => {
        // Build baggage + refresh observability token
        const baggageScope = BaggageBuilderUtils.fromTurnContext(
          new BaggageBuilder(),
          context as any
        ).build();

        await this.preloadObservabilityToken(context);

        try {
          await baggageScope.run(async () => {
            await this.handleAgentNotificationActivity(context, agentNotificationActivity, authHandlerName);
          });
        } catch (err) {
          logger.error('Notification error:', err);
          await context.sendActivity(
            `Sorry, I encountered an error processing the notification: ${err}`
          );
        } finally {
          baggageScope.dispose();
        }
      }
    );
  }

  // -- notification routing ------------------------------------------------

  private async handleAgentNotificationActivity(
    context: TurnContext,
    activity: AgentNotificationActivity,
    authHandlerName: string | null
  ): Promise<void> {
    logger.info(`Notification: ${NotificationType[activity.notificationType] ?? activity.notificationType}`);

    switch (activity.notificationType) {
      case NotificationType.EmailNotification:
        await this.handleEmailNotification(context, activity, authHandlerName);
        break;

      case NotificationType.WpxComment:
        await this.handleWpxCommentNotification(context, activity, authHandlerName);
        break;

      case NotificationType.AgentLifecycleNotification:
        logger.info('Agent lifecycle event received — no reply needed.');
        break;

      default:
        await context.sendActivity(
          `Received notification of type: ${NotificationType[activity.notificationType] ?? activity.notificationType}`
        );
    }
  }

  // -- email notifications -------------------------------------------------

  private async handleEmailNotification(
    context: TurnContext,
    activity: AgentNotificationActivity,
    authHandlerName: string | null
  ): Promise<void> {
    const email = activity.emailNotification;
    if (!email) {
      const errorResponse = createEmailResponseActivity(
        'I could not find the email notification details.'
      );
      await context.sendActivity(errorResponse);
      return;
    }

    try {
      const emailId = (email as any).id ?? '';
      const conversationId = (email as any).conversationId ?? '';
      const senderName = context.activity.from?.name ?? 'unknown sender';

      const message =
        `You have received an email from ${senderName}. ` +
        `Email ID: '${emailId}', Conversation ID: '${conversationId}'. ` +
        `Please process this email and provide a helpful response.`;

      const response = await this.agent.invokeAgentWithScope(
        message,
        this.authorization,
        authHandlerName,
        context
      );

      const emailResponseActivity = createEmailResponseActivity(
        response || 'I have processed your email but do not have a response at this time.'
      );
      await context.sendActivity(emailResponseActivity);
    } catch (error) {
      logger.error('Email notification error:', error);
      const errorResponse = createEmailResponseActivity(
        'Unable to process your email at this time.'
      );
      await context.sendActivity(errorResponse);
    }
  }

  // -- Word comment notifications ------------------------------------------

  private async handleWpxCommentNotification(
    context: TurnContext,
    activity: AgentNotificationActivity,
    authHandlerName: string | null
  ): Promise<void> {
    const wpx = activity.wpxCommentNotification;
    if (!wpx) {
      await context.sendActivity('I could not find the Word notification details.');
      return;
    }

    const docId = (wpx as any).documentId ?? '';
    const commentId = (wpx as any).initiatingCommentId ?? '';
    const driveId = 'default';

    // Get Word document content
    const docMessage =
      `You have a new comment on the Word document with id '${docId}', ` +
      `comment id '${commentId}', drive id '${driveId}'. ` +
      `Please retrieve the Word document as well as the comments and return it in text format.`;
    const wordContent = await this.agent.invokeAgentWithScope(
      docMessage,
      this.authorization,
      authHandlerName,
      context
    );

    // Process the comment with document context
    const commentText = context.activity?.text ?? '';
    const responseMessage =
      `You have received the following Word document content and comments. ` +
      `Please refer to these when responding to comment '${commentText}'. ${wordContent}`;
    const response = await this.agent.invokeAgentWithScope(
      responseMessage,
      this.authorization,
      authHandlerName,
      context
    );

    await context.sendActivity(response);
  }
}
