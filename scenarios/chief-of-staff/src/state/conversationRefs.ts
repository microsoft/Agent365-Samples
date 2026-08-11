// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Per-user ConversationReference store.
//
// The Bot Framework proactive-messaging pattern requires a stored
// ConversationReference for every user we want to DM. Every inbound Activity
// carries one (via `activity.getConversationReference()`), so the moment a
// user talks to the agent — even just "hi" — we cache their ref keyed by
// AAD Object ID. Later, when a scheduled brief / follow-up card needs to be
// sent to that same user, we look up the ref and call
// `adapter.continueConversation(botAppId, ref, ctx => ctx.sendActivity(...))`.
//
// This is the SAME mechanism used for the leader (scheduler.ts caches a
// single "leader" ref) — this module just generalises it to N users so
// non-leader recipients (followup owners, escalation targets) can also
// receive proactive Adaptive Cards.
//
// Persistence: backed by PersistentMap so a restart doesn't force every
// user to DM the agent again before proactive cards can reach them. No
// TTL — refs are tiny (~300 bytes) and stay useful indefinitely; stale
// refs simply fail on the next send with a clear error, at which point
// the user re-DMs and the ref gets refreshed.

import type { Activity, ConversationReference } from '@microsoft/agents-activity';
import { PersistentMap } from './persistentMap';

const refsByAad = new PersistentMap<Partial<ConversationReference>>({
  file: 'conversation-refs.json',
  // No TTL predicate — keep every ref we've ever seen.
});

/**
 * Capture the ConversationReference from an inbound Activity and remember it
 * against the sender's AAD Object ID. Idempotent — refreshes on every call so
 * we always have the most recent conversation/service URL.
 */
export function rememberConversationRef(activity: Activity): void {
  const aad = activity.from?.aadObjectId;
  if (!aad) return;
  const a = activity as any;
  const ref: Partial<ConversationReference> | undefined =
    typeof a.getConversationReference === 'function'
      ? a.getConversationReference()
      : {
          channelId: activity.channelId,
          serviceUrl: activity.serviceUrl,
          conversation: activity.conversation,
          bot: activity.recipient,
          user: activity.from,
        };
  if (ref) {
    refsByAad.set(aad, ref);
  }
}

export function lookupConversationRef(
  aadObjectId: string | undefined | null
): Partial<ConversationReference> | undefined {
  if (!aadObjectId) return undefined;
  return refsByAad.get(aadObjectId);
}

export function hasConversationRef(aadObjectId: string | undefined | null): boolean {
  return !!aadObjectId && refsByAad.has(aadObjectId);
}

/** Diagnostics only — returns the set of AAD IDs we've seen. */
export function listKnownAadIds(): string[] {
  return Array.from(refsByAad.keys());
}
