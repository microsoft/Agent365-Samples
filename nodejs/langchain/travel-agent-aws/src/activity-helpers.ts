// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Pure per-turn helpers used by agent.ts and app.ts (unit tested in test/).
import { randomUUID } from 'node:crypto';
import { AGENTS_CHANNEL, isWpxComment, type WpxComment } from '@microsoft/agents-a365-notifications';

export function isAgentsChannel(activity: any): boolean {
  return String(activity?.channelId ?? '').toLowerCase().startsWith(AGENTS_CHANNEL);
}

// A Word comment turn is identified by the authenticated agents channel AND a WpxComment
// entity. A generic 'mention' entity is NOT evidence: ordinary Teams @mentions carry one too.
export function wordCommentFrom(activity: any): WpxComment | undefined {
  if (!isAgentsChannel(activity)) return undefined;
  return (activity?.entities ?? []).find((e: any) => isWpxComment(e)) as WpxComment | undefined;
}

// Shown to the user as "Reference: <id>" and logged server-side, so the two can be matched.
export function turnCorrelationId(activity: any): string {
  const id = activity?.id;
  return typeof id === 'string' && id.trim() ? id.trim() : randomUUID();
}

// Span agent id: the per-turn agent instance first, then a configured instance id. Never the
// blueprint id — spans attributed to the blueprint would be credited to the wrong identity.
export function spanAgentId(
  recipientAgentId: string | undefined,
  blueprintId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const id = (recipientAgentId || env.AGENT365_OBS_AGENT_ID || env.agent365Observability__agentId || '').trim();
  if (id && blueprintId && id.toLowerCase() === blueprintId.trim().toLowerCase()) return '';
  return id;
}

// User-facing share failure note: a fixed sentence plus the turn reference, never the error text.
export function shareFailureNote(name: string, correlationId: string): string {
  return `\n\n⚠️ I created **${name}** in my OneDrive but could not grant you access, and I did not create a broader link. ` +
    `Reference: ${correlationId}`;
}
