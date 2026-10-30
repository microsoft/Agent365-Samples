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

export interface WordCommentIds {
  // The thread's top-level comment: the id ReplyToComment posts under (.../comments/{id}/replies).
  threadId?: string;
  // The comment or reply the user @mentioned the agent in.
  subjectId?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

// Comment ids from a WpxComment entity. Besides the SDK's initiatingCommentId/subjectCommentId,
// notifications have been seen with commentId/parentCommentId, and the OData path
// (…/comments('<thread>')/replies('<reply>') or …/comments/<thread>/replies/<reply>) names both.
export function wordCommentIds(entity: any): WordCommentIds {
  const odata = str(entity?.odataId) ?? str(entity?.['@odata.id']) ?? str(entity?.['odata.id']) ?? '';
  const seg = (name: string) => new RegExp(`/${name}(?:\\('([^']+)'\\)|\\(([^)'/]+)\\)|/([^/?#()]+))`, 'i').exec(odata);
  const fromPath = (m: RegExpExecArray | null) => (m ? decodeURIComponent(m[1] ?? m[2] ?? m[3]) : undefined);
  const pathThread = fromPath(seg('comments'));
  const pathReply = fromPath(seg('replies'));
  const threadId = str(entity?.initiatingCommentId) ?? str(entity?.parentCommentId) ?? pathThread;
  const subjectId = str(entity?.subjectCommentId) ?? str(entity?.commentId) ?? pathReply ?? threadId;
  return { threadId: threadId ?? subjectId, subjectId };
}

// Field names (never values) of an entity, for diagnosing notification shapes in production logs.
export function entityShape(entity: any): string {
  return entity && typeof entity === 'object' ? Object.keys(entity).sort().join(',') : typeof entity;
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
