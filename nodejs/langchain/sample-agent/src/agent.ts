// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TurnState, AgentApplication, TurnContext, MemoryStorage } from '@microsoft/agents-hosting';
import { Activity, ActivityTypes } from '@microsoft/agents-activity';

// Notification Imports
import '@microsoft/agents-a365-notifications';
import { AgentNotificationActivity, NotificationType, createEmailResponseActivity } from '@microsoft/agents-a365-notifications';
// Observability Imports
import { BaggageBuilder, AgenticTokenCacheInstance, BaggageBuilderUtils } from '@microsoft/opentelemetry';
import { getObservabilityAuthenticationScope } from '@microsoft/agents-a365-runtime';
import tokenCache, { createAgenticTokenCacheKey } from './token-cache';
import { Client, getClient } from './client';

// Maps a user "key" (aadObjectId / id / name) → proactive conversation ID, so
// the WpxComment handler can post a Teams DM back to whichever user @mentioned
// the agent. In-process only — survives the process lifetime; for prod, persist.
const userKeyToConversationId = new Map<string, string>();

function userKeysFor(from: any): string[] {
  if (!from) return [];
  const keys = new Set<string>();
  if (from.aadObjectId) keys.add(`aad:${String(from.aadObjectId).toLowerCase()}`);
  if (from.id) keys.add(`id:${String(from.id).toLowerCase()}`);
  if (from.name) keys.add(`name:${String(from.name).toLowerCase()}`);
  return [...keys];
}

export class A365Agent extends AgentApplication<TurnState> {
  static authHandlerName: string = 'agentic';

  constructor() {
    super({
      storage: new MemoryStorage(),
      proactive: {}, // enable app.proactive; falls back to the application storage
      authorization: {
        agentic: {
          type: 'agentic',
        } // scopes set in the .env file...
      }
    });

    // Route agent notifications
    this.onAgentNotification("agents:*", async (context: TurnContext, state: TurnState, agentNotificationActivity: AgentNotificationActivity) => {
      await this.handleAgentNotificationActivity(context, state, agentNotificationActivity);
    });

    this.onActivity(ActivityTypes.Message, async (context: TurnContext, state: TurnState) => {
      await this.handleAgentMessageActivity(context, state);
    });

    // Handle agent install / uninstall events (agentInstanceCreated / InstallationUpdate)
    this.onActivity(ActivityTypes.InstallationUpdate, async (context: TurnContext, state: TurnState) => {
      await this.handleInstallationUpdateActivity(context, state);
    });
  }

  /**
   * Stores the current Teams conversation reference and indexes it under the
   * user's identifiers, so a later WpxComment from the same user can be routed
   * back into this 1:1 Teams chat as a proactive notification.
   */
  private async trackConversationForProactive(context: TurnContext): Promise<void> {
    try {
      const convId = await this.proactive.storeConversation(context);
      const keys = userKeysFor(context.activity.from);
      for (const k of keys) {
        userKeyToConversationId.set(k, convId);
      }
      console.log(`Tracked Teams conversation '${convId}' for user '${context.activity.from?.name}' under keys: ${keys.join(', ')}`);
    } catch (err) {
      console.error('Failed to store conversation reference for proactive messaging:', err);
    }
  }

  /**
   * Handles incoming user messages and sends responses.
   */
  async handleAgentMessageActivity(turnContext: TurnContext, state: TurnState): Promise<void> {
    const userMessage = turnContext.activity.text?.trim() || '';

    const from = turnContext.activity?.from;
    console.log(`Turn received from user — DisplayName: '${from?.name ?? "(unknown)"}', UserId: '${from?.id ?? "(unknown)"}', AadObjectId: '${from?.aadObjectId ?? "(none)"}'`);
    const displayName = from?.name ?? 'unknown';

    // Remember this Teams chat so we can ping the user proactively when a Word
    // comment notification arrives for them later.
    await this.trackConversationForProactive(turnContext);

    if (!userMessage) {
      await turnContext.sendActivity('Please send me a message and I\'ll help you!');
      return;
    }

    await turnContext.sendActivity('Got it — working on it…');

    // Send typing indicator immediately (awaited so it arrives before the LLM call starts).
    await turnContext.sendActivity({ type: 'typing' } as Activity);

    // Background loop refreshes the "..." animation every ~4s (it times out after ~5s).
    // Only visible in 1:1 and small group chats.
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    const startTypingLoop = () => {
      typingInterval = setInterval(() => {
        turnContext.sendActivity({ type: 'typing' } as Activity).catch(() => {
          // Typing indicator failed — non-critical, continue
        });
      }, 4000);
    };
    const stopTypingLoop = () => { clearInterval(typingInterval); };

    startTypingLoop();

    const baggageScope = BaggageBuilderUtils.fromTurnContext(
      new BaggageBuilder(),
      turnContext as any
    ).sessionDescription('Initial onboarding session')
      .build();

    // Preload/refresh exporter token
    await this.preloadObservabilityToken(turnContext);

    try {
      await baggageScope.run(async () => {
        try {
          const client: Client = await getClient(this.authorization, A365Agent.authHandlerName, turnContext, displayName);
          const response = await client.invokeInferenceScope(userMessage);
          await turnContext.sendActivity(response);
        } catch (error) {
          console.error('LLM query error:', error);
          const err = error as any;
          await turnContext.sendActivity(`Error: ${err.message || err}`);
        }
      });
    } finally {
      stopTypingLoop();
      baggageScope.dispose();
    }
  }

    /**
   * Preloads or refreshes the Observability token used by the Agent 365 Observability exporter.
   */
  private async preloadObservabilityToken(turnContext: TurnContext): Promise<void> {
    const agentId = turnContext?.activity?.recipient?.agenticAppId ?? '';
    const tenantId = turnContext?.activity?.recipient?.tenantId ?? '';

    if (process.env.Use_Custom_Resolver === 'true') {
      const aauToken = await this.authorization.exchangeToken(turnContext, 'agentic', {
        scopes: getObservabilityAuthenticationScope()
      });
      console.log(`Preloaded Observability token for agentId=${agentId}, tenantId=${tenantId}`);
      const cacheKey = createAgenticTokenCacheKey(agentId, tenantId);
      tokenCache.set(cacheKey, aauToken?.token || '');
    } else {
      await AgenticTokenCacheInstance.refreshObservabilityToken(
        agentId,
        tenantId,
        turnContext as any,
        this.authorization as any
      );
    }
  }

  async handleAgentNotificationActivity(context: TurnContext, state: TurnState, agentNotificationActivity: AgentNotificationActivity) {
    switch (agentNotificationActivity.notificationType) {
      case NotificationType.EmailNotification:
        await this.handleEmailNotification(context, state, agentNotificationActivity);
        break;
      case NotificationType.WpxComment:
        await this.handleWpxCommentNotification(context, state, agentNotificationActivity);
        break;
      default:
        await context.sendActivity(`Received notification of type: ${agentNotificationActivity.notificationType}`);
    }
  }

  private async handleWpxCommentNotification(context: TurnContext, state: TurnState, activity: AgentNotificationActivity): Promise<void> {
    const wpx = activity.wpxCommentNotification;
    if (!wpx) {
      console.warn('WpxComment notification missing wpxCommentNotification payload');
      return;
    }

    // Extract the document sharing URL from activity.attachments — the SDK's typed
    // WpxComment view doesn't expose it, but it's reliably present in the raw payload.
    const attachments = (context.activity as any)?.attachments ?? [];
    const fileAttachment = attachments.find((a: any) =>
      typeof a?.contentUrl === 'string' && /\.(docx?|doc)(\?|$)/i.test(a.contentUrl),
    ) ?? attachments[0];
    const documentUrl: string | undefined = fileAttachment?.contentUrl;
    const documentName: string = fileAttachment?.name ?? 'the document';
    const commentText: string = (context.activity as any)?.text ?? '';
    const senderName = context.activity.from?.name ?? 'a user';

    console.log(`WpxComment received — sender='${senderName}', documentName='${documentName}', documentUrl='${documentUrl ?? '(none)'}', commentText='${commentText.substring(0, 200)}', documentId='${wpx.documentId}', initiatingCommentId='${wpx.initiatingCommentId}'`);

    try {
      const client: Client = await getClient(this.authorization, A365Agent.authHandlerName, context);

      const prompt = documentUrl
        ? `${senderName} @mentioned you on a comment in the Word document "${documentName}".\n` +
          `\n` +
          `What the user wrote in the comment:\n` +
          `> ${commentText}\n` +
          `\n` +
          `Document sharing URL: ${documentUrl}\n` +
          `\n` +
          `Your job is to POST A REPLY on that same comment thread. Follow these steps:\n` +
          `1. Call mcp_WordServer.GetDocumentContent with the URL above. The response returns the document's filename, driveId, documentId, plain text content, and a list of every comment with its commentId, author, and text.\n` +
          `2. From the comments list, find the comment that matches the text above and @mentions DocMate (you). If multiple match, pick the most recent that does NOT already have a reply from DocMate.\n` +
          `3. Capture driveId, documentId, and commentId from the GetDocumentContent response.\n` +
          `4. Use the Word reply tool to post a REPLY on that comment thread. Look in your available mcp_WordServer tools for one whose name/description mentions "reply" (e.g. AddCommentReply, ReplyToComment, AddReplyComment) — do NOT use AddComment, that starts a new top-level thread.\n` +
          `5. Reply text: read the comment carefully and answer it directly. Be useful, specific, and brief. If the request is ambiguous, post a brief clarifying question as the reply.\n` +
          `\n` +
          `Constraints:\n` +
          `- Never fabricate IDs. Always pull driveId / documentId / commentId from a tool response.\n` +
          `- Post exactly ONE reply. Do not create new top-level comments.\n` +
          `- Finish with a short summary stating: "Replied to commentId=<id> with: <reply text>".`
        : `${senderName} @mentioned you on a Word comment, but no document URL was attached to the notification. ` +
          `documentId='${wpx.documentId}'. Apologise that you cannot resolve the document without a sharing URL and stop — do not fabricate a URL.`;

      const response = await client.invokeInferenceScope(prompt);
      console.log(`WpxComment handled. LLM summary: ${response?.substring(0, 500)}`);

      // Proactively notify the user in their Teams 1:1 chat (if we have a
      // stored conversation for them — i.e. they have chatted with us or
      // installed us at least once).
      const keys = userKeysFor(context.activity.from);
      const convId = keys.map(k => userKeyToConversationId.get(k)).find(Boolean);
      if (convId) {
        try {
          // Strip the technical prefix so the Teams message reads naturally.
          const m = response?.match(/Replied to commentId=\S+ with:\s*([\s\S]+)/);
          const replyText = (m?.[1] ?? response ?? '').trim();
          const teamsMessage =
            `I replied to your comment on **${documentName}**:\n\n${replyText.substring(0, 1500)}`;
          await this.proactive.sendActivity(this.adapter, convId, { text: teamsMessage });
          console.log(`Proactive Teams notification sent to '${context.activity.from?.name}' (convId='${convId}').`);
        } catch (err) {
          console.error('Failed to send proactive Teams notification:', err);
        }
      } else {
        console.log(`No tracked Teams conversation for sender '${context.activity.from?.name}' (keys tried: ${keys.join(', ')}). Ask them to message DocMate once in Teams to enable Teams notifications for Word @mentions.`);
      }
    } catch (error) {
      console.error('WpxComment handler error:', error);
    }
  }

  private async handleEmailNotification(context: TurnContext, state: TurnState, activity: AgentNotificationActivity): Promise<void> {
    const emailNotification = activity.emailNotification;

    if (!emailNotification) {
      const errorResponse = createEmailResponseActivity('I could not find the email notification details.');
      await context.sendActivity(errorResponse);
      return;
    }

    try {
      const client: Client = await getClient(this.authorization, A365Agent.authHandlerName, context);

      // First, retrieve the email content
      const emailContent = await client.invokeInferenceScope(
        `You have a new email from ${context.activity.from?.name} with id '${emailNotification.id}', ` +
        `ConversationId '${emailNotification.conversationId}'. Please retrieve this message and return it in text format.`
      );

      // Then process the email
      const response = await client.invokeInferenceScope(
        `You have received the following email. Please follow any instructions in it. ${emailContent}`
      );

      const emailResponseActivity = createEmailResponseActivity(response || 'I have processed your email but do not have a response at this time.');
      await context.sendActivity(emailResponseActivity);
    } catch (error) {
      console.error('Email notification error:', error);
      const errorResponse = createEmailResponseActivity('Unable to process your email at this time.');
      await context.sendActivity(errorResponse);
    }
  }
  /**
   * Handles agent install and uninstall events (agentInstanceCreated / InstallationUpdate).
   * Sends a welcome message on install and a farewell on uninstall.
   */
  async handleInstallationUpdateActivity(context: TurnContext, state: TurnState): Promise<void> {
    const from = context.activity?.from;
    console.log(`InstallationUpdate received — Action: '${context.activity.action ?? "(none)"}', DisplayName: '${from?.name ?? "(unknown)"}', UserId: '${from?.id ?? "(unknown)"}'`);

    if (context.activity.action === 'add') {
      // Remember this conversation so we can ping the user proactively when a
      // Word comment notification arrives later.
      await this.trackConversationForProactive(context);
      await context.sendActivity('Thank you for hiring me! Looking forward to assisting you in your professional journey!');
    } else if (context.activity.action === 'remove') {
      await context.sendActivity('Thank you for your time, I enjoyed working with you.');
    }
  }
}

export const agentApplication = new A365Agent();
