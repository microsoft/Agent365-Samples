// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { configDotenv } from 'dotenv';
configDotenv();

import { TurnState, AgentApplication, TurnContext, MemoryStorage } from '@microsoft/agents-hosting';
import { Activity, ActivityTypes } from '@microsoft/agents-activity';
import '@microsoft/agents-a365-notifications';
import {
  AGENTS_CHANNEL,
  AgentNotificationActivity,
  NotificationType,
  isWpxComment,
  type WpxComment,
} from '@microsoft/agents-a365-notifications';
import { Client, CreatedDriveItem, getClient, toolNameIs } from './client.js';
import {
  BoundedTtlMap,
  activityUpn,
  callerAadKey,
  callerAadObjectId,
  callerUpnKey,
  isEmailLike,
} from './identity.js';
// A365 Observability — the app-only OBS token is acquired by the resolver configured in index.ts.
import {
  BaggageBuilder,
  BaggageBuilderUtils,
  InvokeAgentScope,
} from '@microsoft/opentelemetry';
import type { AgentDetails, CallerDetails, UserDetails, InvokeAgentScopeDetails, A365Request, ServiceEndpoint, Channel } from '@microsoft/opentelemetry';

// Proactive 1:1 conversation ids, keyed ONLY by tenant + agent instance + AAD object id or
// verified UPN (see identity.ts). No display-name routing: a Word comment DM must never reach
// a different person who happens to share a name.
const conversationRefByCaller = new BoundedTtlMap<string>(24 * 60 * 60 * 1000);

// UPNs verified for a caller's AAD object id (agents channel, or a roster member whose
// aadObjectId matches the caller's). Keyed by tenant + agent instance + AAD object id.
const verifiedUpnByAad = new BoundedTtlMap<string>(30 * 60 * 1000);

interface VerifiedRequester {
  email?: string;
  source: 'channel' | 'roster' | 'cache' | 'none';
}

// A Word comment turn is identified by the authenticated agents channel AND a WpxComment
// entity. A generic 'mention' entity is NOT evidence: ordinary Teams @mentions carry one too.
function wordCommentFrom(activity: any): WpxComment | undefined {
  const channel = String(activity?.channelId ?? '').toLowerCase();
  if (!channel.startsWith(AGENTS_CHANNEL)) return undefined;
  return (activity?.entities ?? []).find((e: any) => isWpxComment(e)) as WpxComment | undefined;
}

export class TravelTeammateAgent extends AgentApplication<TurnState> {
  static authHandlerName = 'agentic';

  // Varied acknowledgments — picked at random each turn so follow-ups don't feel robotic.
  static ACKS = [
    '✈️ On it — let me find the best options for you…',
    'Looking into that now — give me a moment…',
    'On it! Pulling together some options for you…',
  ];

  constructor() {
    super({
      storage: new MemoryStorage(),
      proactive: {},  // required for proactive Teams DMs (Word comment replies)
      authorization: {
        agentic: { type: 'agentic' },
      },
    });

    // Notifications — priority 1, restricted to agentic auth
    this.onAgentNotification(
      'agents:*',
      async (context, state, notification: AgentNotificationActivity) => {
        await this.handleAgentNotificationActivity(context, state, notification);
      },
      1,
      [TravelTeammateAgent.authHandlerName]
    );

    // Messages — restricted to agentic auth
    this.onActivity(
      ActivityTypes.Message,
      async (context, state) => {
        await this.handleAgentMessageActivity(context, state);
      },
      [TravelTeammateAgent.authHandlerName]
    );

    // Lifecycle — install / uninstall (no auth restriction)
    this.onActivity(ActivityTypes.InstallationUpdate, async (context, state) => {
      await this.handleInstallationUpdateActivity(context, state);
    });
  }

  // wordComment is passed only by the notification route for a verified Word comment
  // (agents channel + WpxComment entity); ordinary Teams messages never take the Word path.
  async handleAgentMessageActivity(
    turnContext: TurnContext,
    state: TurnState,
    wordComment?: WpxComment
  ): Promise<void> {
    const userMessage = turnContext.activity.text?.trim() || '';
    console.log(`[MSG HANDLER] Entered handleAgentMessageActivity, textLength=${userMessage.length}`);
    const from = turnContext.activity?.from;
    const displayName = from?.name ?? 'unknown';

    // Log shapes only — never message text, names, URLs or tool payloads.
    const activity = turnContext.activity as any;
    if (activity.entities?.length || activity.attachments?.length) {
      console.log('[Activity] entities:', JSON.stringify(activity.entities?.map((e: any) => e.type)));
      console.log('[Activity] attachments:', JSON.stringify(activity.attachments?.map((a: any) => a.contentType)));
    }

    const isWordMention = !!wordComment;
    if (isWordMention) {
      console.log('[Word] Handling WpxComment notification');
    }

    // Verified requester identity — feeds sharing, proactive routing and observability.
    const requester = await this.resolveVerifiedRequester(turnContext);

    // Track the conversation for proactive DMs — ONLY for genuine 1:1 turns. A Word comment
    // arrives on the agents channel, which is NOT a DM-able conversation.
    if (!isWordMention) {
      await this.trackConversationForProactive(turnContext, requester.email);
    }

    if (!userMessage) {
      // sendActivity on the agents channel 404s, so only prompt in ordinary chats.
      if (!isWordMention) await turnContext.sendActivity("Please send me a message and I'll help you!");
      return;
    }

    const baggageScope = BaggageBuilderUtils
      .fromTurnContext(new BaggageBuilder(), turnContext as any)
      .sessionDescription('travel-agent-turn')
      .build();

    await baggageScope.run(async () => {
      // A365 Observability — start the InvokeAgentScope FIRST (before any send) and
      // publish its span context to turnState. The OutputLoggingMiddleware (enabled in
      // index.ts via configureA365Hosting) reads turnState['A365ParentSpanId'] on each
      // outbound message; setting it here links the ack + final response to this
      // agent-invocation span.
      const agentDetails: AgentDetails = {
        agentId: turnContext.activity?.recipient?.agenticAppId ?? process.env.agent365Observability__agentId ?? '',
        agentName: process.env.agent365Observability__agentName ?? 'TravelTeammate',
        agentDescription: process.env.agent365Observability__agentDescription ?? '',
        // Blueprint id — emitted as the `microsoft.a365.agent.blueprint.id` span tag so MAC
        // can roll activity up to the blueprint (not just the per-instance AUID).
        agentBlueprintId: process.env.agent365Observability__agentBlueprintId
          ?? (turnContext.activity?.recipient as any)?.agenticAppBlueprintId ?? '',
        tenantId: turnContext.activity?.recipient?.tenantId ?? process.env.agent365Observability__tenantId ?? '',
      };
      // MAC's "User principal name" column reads userEmail; only a verified UPN is emitted.
      const callerDetails: CallerDetails = {
        userDetails: {
          userId: from?.aadObjectId ?? activityUpn(turnContext) ?? '',
          userName: displayName,
          userEmail: requester.email,
        } as UserDetails,
      };
      console.log(
        `[Caller] aadObjectId=${from?.aadObjectId ? 'present' : 'absent'} verifiedUpn=${requester.email ? 'present' : 'absent'} (source=${requester.source})`,
      );
      const request: A365Request = {
        content: userMessage,
        sessionId: turnContext.activity?.conversation?.id ?? '',
        conversationId: turnContext.activity?.conversation?.id ?? '',
        channel: { name: 'msteams' } as Channel,
      };
      const scopeDetails: InvokeAgentScopeDetails = {
        endpoint: { host: 'localhost', port: 3978 } as ServiceEndpoint,
      };

      let scope: InvokeAgentScope | null = null;
      try {
        scope = InvokeAgentScope.start(request, scopeDetails, agentDetails, callerDetails);
        (turnContext.turnState as any).set('A365ParentSpanId', scope.getSpanContext());
      } catch (scopeErr) {
        console.error('[Scope] Failed to start scope:', scopeErr);
      }

      // Word comment turns arrive on the agents channel whose reply URL rejects normal
      // activities — every sendActivity there 404s. The reply is delivered via the MCP
      // ReplyToComment tool + a proactive DM instead, so skip the ack/typing for these turns.
      if (!isWordMention) {
        try {
          const ack = TravelTeammateAgent.ACKS[Math.floor(Math.random() * TravelTeammateAgent.ACKS.length)];
          await turnContext.sendActivity(ack);
          await turnContext.sendActivity({ type: 'typing' } as Activity);
        } catch (typingErr) {
          console.warn('[Flow] Initial sendActivity failed:', (typingErr as any)?.message?.slice(0, 100));
        }
      }

      let typingInterval: ReturnType<typeof setInterval> | undefined;
      const startTypingLoop = () => {
        typingInterval = setInterval(() => {
          turnContext.sendActivity({ type: 'typing' } as Activity).catch(() => {});
        }, 4000);
      };
      const stopTypingLoop = () => clearInterval(typingInterval);

      if (!isWordMention) startTypingLoop();

      try {
        const doWork = async () => {
          if (scope) scope.recordInputMessages([userMessage]);

          const client: Client = await getClient(
            this.authorization,
            TravelTeammateAgent.authHandlerName,
            turnContext,
            { verifiedUpn: requester.email }
          );

          let effectiveMessage = userMessage;
          let documentName = 'the document';
          const commentIds = new Set<string>();
          if (wordComment) {
            const attachments = (turnContext.activity as any)?.attachments ?? [];
            const fileAttachment = attachments.find((a: any) =>
              typeof a?.contentUrl === 'string' && /\.(docx?|doc)(\?|$)/i.test(a.contentUrl),
            ) ?? attachments[0];
            const documentUrl = fileAttachment?.contentUrl ?? '';
            documentName = fileAttachment?.name ?? 'the document';
            const cleanText = userMessage.replace(/<at>.*?<\/at>/gi, '').trim();
            const senderName = from?.name ?? 'a user';

            // Prefer the subject comment (the exact reply the user @mentioned us on); fall
            // back to the thread root.
            const documentId = wordComment.documentId ?? '';
            const commentId = wordComment.subjectCommentId ?? wordComment.initiatingCommentId ?? '';
            for (const id of [wordComment.subjectCommentId, wordComment.initiatingCommentId]) {
              if (id) commentIds.add(id);
            }
            const idBlock =
              (documentId ? `documentId: ${documentId}\n` : '') +
              (commentId ? `commentId (reply to THIS comment): ${commentId}\n` : '');

            effectiveMessage =
              `A user (${senderName}) @mentioned you on a comment in the Word document "${documentName}".\n` +
              `Their comment: "${cleanText}"\n` +
              (documentUrl ? `Document URL: ${documentUrl}\n` : '') +
              idBlock + `\n` +
              `Do exactly this, using the FEWEST possible tool calls:\n` +
              `1. Read the document ONCE via mcp_WordServer GetDocumentContent (use the Document URL) — do NOT call it more than once.\n` +
              `2. Reply to THAT comment with mcp_WordServer ReplyToComment, using commentId above — never AddComment, never start a new thread.\n` +
              `3. Keep the reply concise and directly useful. Do not call any other tools.`;
            console.log('[Word] Augmented prompt for Word tools');
          }

          // Without the notified comment's id a reply can't be verified to land on it — don't
          // let the model pick a comment; tell the user instead.
          if (wordComment && commentIds.size === 0) {
            console.warn('[Word] WpxComment has no subject/initiating comment id — not replying.');
            const convId = this.findDmConversation(turnContext);
            if (!convId) {
              console.warn('[Proactive] No verified 1:1 mapping for this caller in tenant/agent scope — DM skipped.');
              return;
            }
            try {
              await (this as any).proactive.sendActivity((this as any).adapter, convId, {
                text: `⚠️ You @mentioned me on a comment in **${documentName}**, but I couldn't identify which comment, so I didn't reply there. Message me here with your question instead.`,
              });
            } catch (dmErr) {
              console.warn('[Word] Proactive DM failed:', (dmErr as Error)?.name ?? 'Error');
            }
            return;
          }

          console.log('[Flow] Invoking LLM...');
          const detailed = await client.invokeDetailed(effectiveMessage);
          let response = detailed.text;
          for (const t of detailed.tools) {
            console.log(`[Tools] ${t.name} → ${t.status}`);
          }

          // The Word reply only counts as posted if ReplyToComment ran THIS turn, targeted the
          // notified comment, and did not error. The model's prose is never trusted for this.
          let postedReply: string | undefined;
          if (wordComment) {
            const replies = detailed.tools.filter((t) =>
              toolNameIs(t.name, 'ReplyToComment') && commentIds.has(String(t.args?.commentId ?? '')));
            const replyTool = replies.find((t) => t.status === 'success');
            if (replyTool) {
              postedReply = String(replyTool.args?.newComment ?? '').trim() || response;
              console.log('[Word] ReplyToComment succeeded — comment posted to Word.');
            } else if (replies.length) {
              console.warn('[Word] ReplyToComment FAILED — comment not posted.');
            } else {
              console.warn('[Word] ReplyToComment was not called for the notified comment — nothing was posted to Word.');
            }
          } else {
            // Deterministic share: the code (not the model) grants the verified requester edit
            // access to every file created this turn, and reports the real outcome.
            response += await this.shareCreatedItems(client, detailed.createdItems, requester);
          }

          console.log(`[Response] Got response (${response?.length ?? 0} chars)`);
          if (scope) scope.recordOutputMessages([response]);
          if (!isWordMention) {
            try {
              await turnContext.sendActivity(response);
              console.log('[Response] Sent successfully');
            } catch (sendErr) {
              console.warn('[Response] sendActivity failed:', (sendErr as any)?.message?.slice(0, 100));
            }
          }

          // Word comment: the user isn't watching the document — DM them in Teams, but only
          // through a verified 1:1 mapping for this exact tenant/agent/caller.
          if (isWordMention) {
            try {
              const convId = this.findDmConversation(turnContext);
              if (!convId) {
                console.warn('[Proactive] No verified 1:1 mapping for this caller in tenant/agent scope — DM skipped; ask the user to message me directly once.');
              } else if (postedReply !== undefined) {
                await (this as any).proactive.sendActivity((this as any).adapter, convId, {
                  text: `I replied to your comment on **${documentName}**:\n\n${postedReply.substring(0, 1500)}`,
                });
                console.log('[Word] Proactive DM sent (reply confirmed posted)');
              } else {
                await (this as any).proactive.sendActivity((this as any).adapter, convId, {
                  text: `⚠️ I couldn't post my reply onto **${documentName}** (the Word reply didn't go through). Here's what I wanted to say:\n\n${response?.substring(0, 1500)}`,
                });
                console.log('[Word] Proactive DM sent (reply NOT posted — sent fallback message)');
              }
            } catch (dmErr) {
              console.warn('[Word] Proactive DM failed:', (dmErr as any)?.message?.slice(0, 120));
            }
          }
        };

        if (scope) {
          await scope.withActiveSpanAsync(async () => {
            try {
              await doWork();
            } catch (error) {
              console.error('[Flow] Error inside scope span:', error);
              const err = error as any;
              if (scope) scope.recordError(error as Error);
              if (!isWordMention) await turnContext.sendActivity(`Error: ${err.message || err}`);
            } finally {
              stopTypingLoop();
            }
          });
        } else {
          try {
            await doWork();
          } catch (error) {
            console.error('[Flow] Error (no scope):', error);
            const err = error as any;
            if (!isWordMention) await turnContext.sendActivity(`Error: ${err.message || err}`);
          } finally {
            stopTypingLoop();
          }
        }
      } catch (outerErr) {
        console.error('[Flow] OUTER error (scope wrapper failed):', outerErr);
        stopTypingLoop();
      } finally {
        if (scope) scope.dispose();
      }
    });
  }

  // Grants the verified requester write access to each created item and returns user-facing
  // status lines. Never creates organization-wide or anonymous links as a fallback.
  private async shareCreatedItems(
    client: Client,
    items: CreatedDriveItem[],
    requester: VerifiedRequester
  ): Promise<string> {
    let notes = '';
    for (const item of items) {
      const name = item.name ?? 'the document';
      const link = item.webUrl ? `: ${item.webUrl}` : '';
      if (!item.itemId) {
        console.warn(`[Share] ${item.tool} succeeded but the created item could not be identified — not shared`);
        notes += `\n\n⚠️ I created a document in my OneDrive, but I couldn't identify it in the tool result, so I ` +
          `couldn't share it with you. I did not create a broader link. Ask me to create it again.`;
        continue;
      }
      const requesterEmail = requester.email?.toLowerCase();
      if (!requesterEmail) {
        console.warn(`[Share] ${item.itemId}: no verified requester email — not shared`);
        notes += `\n\n⚠️ I created **${name}** in my OneDrive, but I couldn't verify your work account, so I didn't share it. ` +
          `Message me directly in Teams (1:1) and ask again.`;
        continue;
      }
      if (item.sharedWith?.trim().toLowerCase() === requesterEmail) {
        console.log(`[Share] ${item.itemId}: already shared with the requester by ${item.tool}`);
        notes += `\n\n📄 **${name}** — you have edit access${link}`;
        continue;
      }
      const r = await client.grantEditAccess(item, requesterEmail);
      if (r.ok) {
        console.log(`[Share] ${item.itemId}: granted requester write access`);
        notes += `\n\n📄 **${name}** — you have edit access${link}`;
      } else {
        console.warn(`[Share] ${item.itemId}: could not grant requester access (error length ${r.error?.length ?? 0})`);
        notes += `\n\n⚠️ I created **${name}** in my OneDrive but could not grant you access (${r.error}). ` +
          `I did not create a broader link.`;
      }
    }
    return notes;
  }

  async handleAgentNotificationActivity(
    context: TurnContext,
    state: TurnState,
    notification: AgentNotificationActivity
  ): Promise<void> {
    const entities = (context.activity as any).entities ?? [];
    console.log(`[NOTIF HANDLER] Entered, type=${notification.notificationType}, channel=${context.activity.channelId}, entities=${JSON.stringify(entities.map((e: any) => e.type))}`);

    switch (notification.notificationType) {
      case NotificationType.EmailNotification:
        // Email notifications are intentionally ignored — this sample does not act on email (no LLM call, no reply).
        console.log('[Email] notification ignored (email handling disabled).');
        return;
      case NotificationType.WpxComment: {
        const wpx = notification.wpxCommentNotification ?? wordCommentFrom(context.activity);
        if (wpx) {
          await this.handleAgentMessageActivity(context, state, wpx);
        } else {
          console.warn('[Word] WpxComment notification without a WpxComment entity — ignored');
        }
        return;
      }
      default:
        // Replying on the agents channel 404s, so unhandled notification types are only logged.
        console.log(`[NOTIF HANDLER] Ignoring notification of type ${notification.notificationType}`);
    }
  }

  private async trackConversationForProactive(context: TurnContext, verifiedUpn?: string): Promise<void> {
    try {
      const a: any = context.activity;
      // Only a verified Teams 1:1 chat may receive proactive DMs (which can carry document text).
      if (a?.conversation?.conversationType !== 'personal') return;
      if (String(a?.channelId ?? '').toLowerCase() !== 'msteams' || a?.conversation?.isGroup === true) return;
      const aadKey = callerAadKey(context);
      if (!aadKey) {
        console.warn('[Proactive] No aadObjectId/tenant/agent — not storing a DM reference.');
        return;
      }
      const convId = await (this as any).proactive.storeConversation(context);
      conversationRefByCaller.set(aadKey, convId);
      const upnKey = callerUpnKey(context, verifiedUpn);
      if (upnKey) conversationRefByCaller.set(upnKey, convId);
    } catch {
      // Proactive tracking failed — Word comment DMs will be unavailable
    }
  }

  // Only follows a verified mapping; never falls back to names or "most recent conversation".
  private findDmConversation(context: TurnContext): string | undefined {
    const aadKey = callerAadKey(context);
    const upnKey = callerUpnKey(context, activityUpn(context));
    return (aadKey && conversationRefByCaller.get(aadKey)) || (upnKey && conversationRefByCaller.get(upnKey)) || undefined;
  }

  // Resolve the caller's UPN from stable identity only — never from from.name.
  // (1) the JWT-validated agents channel carries it in from.id; (2) a previously verified
  // UPN for this tenant/agent/aadObjectId; (3) the Teams roster, accepted only when the
  // member's AAD object id equals the caller's.
  private async resolveVerifiedRequester(turnContext: TurnContext): Promise<VerifiedRequester> {
    const aadKey = callerAadKey(turnContext);
    const direct = activityUpn(turnContext);
    if (direct) {
      if (aadKey) verifiedUpnByAad.set(aadKey, direct);
      return { email: direct, source: 'channel' };
    }
    if (!aadKey) return { source: 'none' };
    const cached = verifiedUpnByAad.get(aadKey);
    if (cached) return { email: cached, source: 'cache' };

    const from: any = turnContext.activity?.from;
    const convId = turnContext.activity?.conversation?.id;
    const memberId = from?.id;
    if (!convId || !memberId) return { source: 'none' };

    try {
      // ConnectorClientKey is a per-adapter-instance Symbol, read off the adapter instance
      // the way the SDK's own teamsAttachmentDownloader does.
      const key = (turnContext as any).adapter?.ConnectorClientKey;
      const connector: any = key ? (turnContext.turnState as any).get(key) : undefined;
      if (!connector?.getConversationMember) {
        console.warn('[Caller] No connector client on turnState — cannot resolve UPN.');
        return { source: 'none' };
      }
      const member: any = await connector.getConversationMember(memberId, convId);
      const memberOid = String(member?.aadObjectId ?? member?.objectId ?? '').toLowerCase();
      if (!memberOid || memberOid !== callerAadObjectId(turnContext)) {
        console.warn('[Caller] Roster member aadObjectId missing or mismatched — UPN not trusted.');
        return { source: 'none' };
      }
      const upn = [member?.userPrincipalName, member?.email, member?.upn].find(isEmailLike)?.toLowerCase();
      if (!upn) return { source: 'none' };
      verifiedUpnByAad.set(aadKey, upn);
      return { email: upn, source: 'roster' };
    } catch (err) {
      console.warn('[Caller] UPN lookup via connector failed:', (err as any)?.message?.slice(0, 120));
      return { source: 'none' };
    }
  }

  async handleInstallationUpdateActivity(
    context: TurnContext,
    _state: TurnState
  ): Promise<void> {
    if (context.activity.action === 'add') {
      await this.trackConversationForProactive(context);
      await context.sendActivity(
        'Thank you for hiring me! I\'m your travel assistant — give me a destination and dates, and I\'ll find flights, hotels, and restaurants for you!'
      );

      // MCP warm-up — connecting to the Word/OneDrive MCP servers costs ~6–10s and is
      // normally paid on the user's FIRST message. Pre-build and cache the MCP agent now
      // (cached only when the caller has a stable identity). Best-effort.
      try {
        const warmStart = Date.now();
        await getClient(this.authorization, TravelTeammateAgent.authHandlerName, context);
        console.log(`[MCP] Warm-up on install complete in ${Date.now() - warmStart}ms`);
      } catch (warmErr) {
        console.warn('[MCP] Warm-up on install failed (first message will connect normally):', (warmErr as any)?.message?.slice(0, 120));
      }
    } else if (context.activity.action === 'remove') {
      await context.sendActivity('Thank you for your time, I enjoyed helping you plan trips!');
    }
  }
}

export const agentApplication = new TravelTeammateAgent();
