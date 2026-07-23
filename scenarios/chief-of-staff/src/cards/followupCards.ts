// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Adaptive Card tools for the enhanced Follow-up flow:
//   - send_followup_check_in_card       (owner)
//   - send_extension_request_card       (leader, from "need more time")
//   - send_blocker_meeting_card         (leader, from "I'm blocked")
//   - send_escalation_card              (leader, from stale followup)
//
// Every card uses Action.Submit with a `verb` and follow-up context in the
// action data. When Teams routes the click back to the bot it arrives as an
// Invoke activity — handled in agent.ts. As a fallback, each card also tells
// the user they can just reply with a keyword.
//
// Delivery: Bot Framework proactive messaging (adapter.continueConversation
// + sendActivity) — see cards/proactiveSend.ts. A cached
// ConversationReference is required for the recipient, which we get the
// first time they DM the agent OR install the app. There is intentionally
// no Graph /chats fallback: that would require Chat.ReadWrite (delegated)
// on the blueprint identity, which we are strictly avoiding.

import { tool } from '@openai/agents';
import { Authorization, CloudAdapter, TurnContext } from '@microsoft/agents-hosting';
import { createFollowup, PendingFollowup } from '../state/followupStore';
import { getBotAppId, sendCardProactively } from './proactiveSend';
import { hasConversationRef } from '../state/conversationRefs';

export interface CardToolOptions {
  authorization: Authorization;
  context: TurnContext;
  authHandlerName: string;
}

// ─── Shared card-send helper ───────────────────────────────────────────────
// Delivery: Bot Framework proactive send only
// (adapter.continueConversation). Requires a cached ConversationReference
// for the recipient — created the first time they DM the agent or install
// the app. Sub-second latency, no Graph call, no blueprint permissions.
//
// If no ref is cached we log a clear warning and return conversationId=undefined.
// The caller (LLM) will see `ok:false` and can surface the bootstrap ask
// ("please DM me once first") to the leader.
async function sendCardToUser(
  opts: CardToolOptions,
  recipientAad: string,
  card: object,
  _attachmentId: string
): Promise<{ conversationId: string | undefined }> {
  if (!hasConversationRef(recipientAad)) {
    console.warn(
      `[cards/sendCardToUser] No cached ConversationReference for aad=${recipientAad} — ` +
        `recipient must DM the Chief of Staff agent (or install the app) at least once ` +
        `before we can DM them a card. Skipping delivery.`
    );
    return { conversationId: undefined };
  }
  const adapter = (opts.context as any).adapter as CloudAdapter;
  const result = await sendCardProactively({
    adapter,
    botAppId: getBotAppId(),
    recipientAad,
    card,
  });
  return result;
}

function toolFail(name: string, err: unknown, hint?: string): string {
  const e = err as any;
  const msg = e?.response?.data ?? e?.message ?? String(e);
  console.error(`[cards/${name}] failed:`, msg);
  return JSON.stringify({ ok: false, tool: name, error: msg, ...(hint ? { hint } : {}) });
}

// ─── Header helper ─────────────────────────────────────────────────────────
// Clean, professional card header: bold title on the left with a subtle
// subtitle underneath, and an optional coloured tag pinned to the right
// (e.g. "Action needed" in amber for follow-ups, "Urgent" in red for
// escalations). Replaces the previous full-bleed accent block, which read
// as heavy on modern Teams themes.
function cardHeader(
  title: string,
  subtitle: string,
  tag?: { text: string; color?: 'Accent' | 'Warning' | 'Attention' | 'Good' | 'Default' }
): object {
  const columns: any[] = [
    {
      type: 'Column',
      width: 'stretch',
      items: [
        {
          type: 'TextBlock',
          text: title,
          weight: 'Bolder',
          size: 'Large',
          wrap: true,
        },
        {
          type: 'TextBlock',
          text: subtitle,
          isSubtle: true,
          size: 'Small',
          spacing: 'None',
          wrap: true,
        },
      ],
    },
  ];
  if (tag) {
    columns.push({
      type: 'Column',
      width: 'auto',
      verticalContentAlignment: 'Center',
      items: [
        {
          type: 'TextBlock',
          text: tag.text,
          weight: 'Bolder',
          size: 'Small',
          color: tag.color ?? 'Accent',
          horizontalAlignment: 'Right',
          wrap: false,
        },
      ],
    });
  }
  return { type: 'ColumnSet', columns };
}

/**
 * Renders the task-title block that sits under the header on every card.
 * Uses a subtle separator so it visually reads as its own section.
 */
function taskTitleBlock(taskTitle: string): object {
  return {
    type: 'TextBlock',
    text: taskTitle,
    weight: 'Bolder',
    size: 'Medium',
    wrap: true,
    spacing: 'Medium',
    separator: true,
  };
}

/**
 * Compact metadata row rendered as a ColumnSet — e.g.
 *   Due  Thu 16 Jul     ·     Owner  Adele Vance
 * Each entry has a subtle label and a normal-weight value stacked. Much
 * lighter visually than a FactSet and reads well on mobile.
 */
function metaRow(entries: Array<{ label: string; value: string }>): object {
  return {
    type: 'ColumnSet',
    spacing: 'Small',
    columns: entries.map((e) => ({
      type: 'Column',
      width: 'stretch',
      items: [
        {
          type: 'TextBlock',
          text: e.label.toUpperCase(),
          size: 'Small',
          isSubtle: true,
          weight: 'Bolder',
          wrap: false,
          spacing: 'None',
        },
        {
          type: 'TextBlock',
          text: e.value,
          wrap: true,
          spacing: 'None',
        },
      ],
    })),
  };
}

/** Subtle footer hint (kept identical across cards for a consistent voice). */
function footerHint(text: string): object {
  return {
    type: 'TextBlock',
    text,
    wrap: true,
    isSubtle: true,
    size: 'Small',
    spacing: 'Medium',
    separator: true,
  };
}

function actionButton(title: string, verb: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'Action.Submit',
    title,
    data: { verb, ...extra },
  };
}

// ─── 1. Follow-up check-in card (agent → owner) ────────────────────────────
export interface FollowupCheckInArgs {
  taskId: string;
  taskTitle: string;
  ownerAadObjectId: string;
  ownerName: string;
  dueDate?: string | null;
}

export function buildFollowupCheckInCard(args: FollowupCheckInArgs, followupId: string): object {
  const dueLabel = args.dueDate
    ? new Date(args.dueDate).toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      })
    : 'No due date';
  const firstName = args.ownerName?.split(' ')[0] ?? 'there';
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    body: [
      cardHeader('Quick check-in', 'Chief of Staff', {
        text: 'Action needed',
        color: 'Accent',
      }),
      taskTitleBlock(args.taskTitle),
      metaRow([
        { label: 'Due', value: dueLabel },
        { label: 'Owner', value: args.ownerName },
      ]),
      {
        type: 'TextBlock',
        text: `Hi ${firstName}, how's this one going?`,
        wrap: true,
        spacing: 'Medium',
      },
      footerHint('Pick an option below, or reply `on track` / `extend` / `blocked`.'),
    ],
    actions: [
      actionButton('On track', 'ontrack', { followupId, taskId: args.taskId }),
      actionButton('Need more time', 'extend', { followupId, taskId: args.taskId }),
      actionButton("I'm blocked", 'blocked', { followupId, taskId: args.taskId }),
    ],
  };
}

export function createFollowupCheckInTool(opts: CardToolOptions) {
  return tool({
    name: 'send_followup_check_in_card',
    description:
      'DM a task owner an Adaptive Card asking them for a status check-in on one Planner task. ' +
      'Card has 3 buttons: On track / Need more time / I\'m blocked. ' +
      'Records the follow-up in the store so we can escalate if the owner doesn\'t respond.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: { type: 'string', description: 'Planner task id.' },
        taskTitle: { type: 'string', description: 'Human-readable task title.' },
        ownerAadObjectId: { type: 'string', description: 'AAD Object ID of the owner (DM recipient).' },
        ownerName: { type: 'string', description: 'Owner display name — for a friendlier greeting.' },
        dueDate: {
          type: ['string', 'null'],
          description: 'ISO due date (optional). Shown to owner for context.',
        },
      },
      required: ['taskId', 'taskTitle', 'ownerAadObjectId', 'ownerName', 'dueDate'],
    } as any,
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs ?? {}) as FollowupCheckInArgs;
      try {
        const record: PendingFollowup = createFollowup({
          taskId: args.taskId,
          taskTitle: args.taskTitle,
          ownerAad: args.ownerAadObjectId,
          ownerName: args.ownerName,
          dueDate: args.dueDate ?? undefined,
        });
        const card = buildFollowupCheckInCard(args, record.followupId);
        const { conversationId } = await sendCardToUser(opts, args.ownerAadObjectId, card, 'followup-checkin');
        return JSON.stringify({
          ok: true,
          followupId: record.followupId,
          conversationId,
        });
      } catch (err) {
        return toolFail('send_followup_check_in_card', err);
      }
    },
  });
}

// ─── 2. Extension request card (agent → leader) ────────────────────────────
export interface ExtensionRequestArgs {
  leaderAadObjectId: string;
  followupId: string;
  taskId: string;
  taskTitle: string;
  ownerName: string;
  currentDueDate?: string | null;
  suggestedNewDueDate: string; // ISO
  agentRationale?: string | null;
}

function buildExtensionRequestCard(args: ExtensionRequestArgs): object {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  const current = args.currentDueDate ? fmt(args.currentDueDate) : 'unknown';
  const newDate = fmt(args.suggestedNewDueDate);
  const body: any[] = [
    cardHeader('Extension request', `From ${args.ownerName}`, {
      text: 'Approval needed',
      color: 'Warning',
    }),
    taskTitleBlock(args.taskTitle),
    metaRow([
      { label: 'Current due', value: current },
      { label: 'Proposed', value: newDate },
      { label: 'Owner', value: args.ownerName },
    ]),
  ];
  if (args.agentRationale) {
    body.push({
      type: 'TextBlock',
      text: args.agentRationale,
      wrap: true,
      isSubtle: true,
      spacing: 'Medium',
    });
  }
  body.push(footerHint('Pick an option below, or reply `approve` / `reject` / `reassign`.'));
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    body,
    actions: [
      actionButton('Approve new date', 'approve_extend', {
        followupId: args.followupId,
        taskId: args.taskId,
        newDueDate: args.suggestedNewDueDate,
      }),
      actionButton('Reject', 'reject_extend', {
        followupId: args.followupId,
        taskId: args.taskId,
      }),
      actionButton('Reassign', 'reassign', {
        followupId: args.followupId,
        taskId: args.taskId,
      }),
    ],
  };
}

export function createExtensionRequestTool(opts: CardToolOptions) {
  return tool({
    name: 'send_extension_request_card',
    description:
      'DM the leader an Adaptive Card asking whether to approve a task extension. ' +
      'Use when a task owner has replied "need more time". Provide a suggested new due date.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leaderAadObjectId: { type: 'string' },
        followupId: { type: 'string', description: 'From the original followup record.' },
        taskId: { type: 'string' },
        taskTitle: { type: 'string' },
        ownerName: { type: 'string' },
        currentDueDate: { type: ['string', 'null'], description: 'ISO date, if known.' },
        suggestedNewDueDate: { type: 'string', description: 'ISO date proposed by the agent.' },
        agentRationale: { type: ['string', 'null'], description: 'One-line reason, e.g. "Owner cited scope creep."' },
      },
      required: [
        'leaderAadObjectId',
        'followupId',
        'taskId',
        'taskTitle',
        'ownerName',
        'currentDueDate',
        'suggestedNewDueDate',
        'agentRationale',
      ],
    } as any,
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs ?? {}) as ExtensionRequestArgs;
      try {
        const card = buildExtensionRequestCard(args);
        const { conversationId } = await sendCardToUser(opts, args.leaderAadObjectId, card, 'extension-request');
        return JSON.stringify({ ok: true, conversationId });
      } catch (err) {
        return toolFail('send_extension_request_card', err);
      }
    },
  });
}

// ─── 3. Blocker meeting request card (agent → leader) ──────────────────────
export interface BlockerMeetingArgs {
  leaderAadObjectId: string;
  followupId: string;
  taskId: string;
  taskTitle: string;
  ownerName: string;
  ownerAadObjectId: string;
  blockerSummary: string;
  proposedTimes: string[]; // human strings, e.g. ["Tue 2 PM", "Wed 10 AM"]
  /** Optional parallel array of ISO strings for each proposedTimes slot.
   *  When provided, the "Book …" buttons carry the ISO in data.timeslotIso so
   *  the book_meeting handler doesn't have to ask the LLM to parse the human
   *  string. */
  proposedTimesIso?: string[];
}

export function buildBlockerMeetingCard(args: BlockerMeetingArgs): object {
  const timeActions = args.proposedTimes.slice(0, 3).map((t, i) =>
    actionButton(`📅 Book ${t}`, 'book_meeting', {
      followupId: args.followupId,
      taskId: args.taskId,
      ownerAad: args.ownerAadObjectId,
      timeslot: t,
      timeslotIso: args.proposedTimesIso?.[i],
    })
  );
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    body: [
      cardHeader('🚧 Blocker reported', `${args.ownerName} is stuck`, {
        text: 'Urgent',
        color: 'Attention',
      }),
      {
        type: 'TextBlock',
        text: `**${args.taskTitle}**`,
        wrap: true,
        spacing: 'Medium',
      },
      {
        type: 'TextBlock',
        text: args.blockerSummary,
        wrap: true,
        isSubtle: true,
      },
      {
        type: 'TextBlock',
        text: 'Pick a time to meet — I\'ll book it with the owner. Or reply `defer`.',
        wrap: true,
        isSubtle: true,
        spacing: 'Medium',
      },
    ],
    actions: [
      ...timeActions,
      actionButton('⏭ Handle later', 'defer_blocker', {
        followupId: args.followupId,
        taskId: args.taskId,
      }),
    ],
  };
}

export function createBlockerMeetingTool(opts: CardToolOptions) {
  return tool({
    name: 'send_blocker_meeting_card',
    description:
      'DM the leader an Adaptive Card with the blocker details + 2-3 proposed meeting times. ' +
      'Use when a task owner has replied "I\'m blocked".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leaderAadObjectId: { type: 'string' },
        followupId: { type: 'string' },
        taskId: { type: 'string' },
        taskTitle: { type: 'string' },
        ownerName: { type: 'string' },
        ownerAadObjectId: { type: 'string' },
        blockerSummary: {
          type: 'string',
          description: 'One-sentence summary of what the owner is stuck on.',
        },
        proposedTimes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Human-readable time slots — e.g. ["Tue 2 PM", "Wed 10 AM"]. Max 3.',
        },
      },
      required: [
        'leaderAadObjectId',
        'followupId',
        'taskId',
        'taskTitle',
        'ownerName',
        'ownerAadObjectId',
        'blockerSummary',
        'proposedTimes',
      ],
    } as any,
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs ?? {}) as BlockerMeetingArgs;
      try {
        const card = buildBlockerMeetingCard(args);
        const { conversationId } = await sendCardToUser(opts, args.leaderAadObjectId, card, 'blocker-meeting');
        return JSON.stringify({ ok: true, conversationId });
      } catch (err) {
        return toolFail('send_blocker_meeting_card', err);
      }
    },
  });
}

// ─── 4. Escalation card (agent → leader for stale followup) ────────────────
interface EscalationArgs {
  leaderAadObjectId: string;
  followupId: string;
  taskId: string;
  taskTitle: string;
  ownerName: string;
  hoursSinceReminder: number;
  dueDate?: string | null;
}

function buildEscalationCard(args: EscalationArgs): object {
  const dueLabel = args.dueDate ? `Due ${new Date(args.dueDate).toLocaleDateString()}` : 'No due date';
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    body: [
      {
        type: 'Container',
        style: 'attention',
        bleed: true,
        items: [
          {
            type: 'TextBlock',
            text: '🚨 Escalation — no reply',
            weight: 'Bolder',
            size: 'ExtraLarge',
            color: 'Light',
            wrap: true,
          },
          {
            type: 'TextBlock',
            text: 'From your Chief of Staff',
            isSubtle: true,
            color: 'Light',
            spacing: 'None',
          },
        ],
      },
      {
        type: 'TextBlock',
        text: `**${args.taskTitle}**`,
        wrap: true,
        spacing: 'Medium',
      },
      {
        type: 'FactSet',
        facts: [
          { title: 'Owner', value: args.ownerName },
          { title: 'Status', value: dueLabel },
          {
            title: 'Reminded',
            value: `${args.hoursSinceReminder.toFixed(1)} hours ago — no response`,
          },
        ],
      },
      {
        type: 'TextBlock',
        text: 'Pick an action — or reply `reassign` / `extend` / `escalate`.',
        wrap: true,
        isSubtle: true,
        spacing: 'Medium',
      },
    ],
    actions: [
      actionButton('🔀 Reassign', 'esc_reassign', {
        followupId: args.followupId,
        taskId: args.taskId,
      }),
      actionButton('⏰ Give more time', 'esc_extend', {
        followupId: args.followupId,
        taskId: args.taskId,
      }),
      actionButton('📢 Escalate to me', 'esc_escalate', {
        followupId: args.followupId,
        taskId: args.taskId,
      }),
    ],
  };
}

export function createEscalationTool(opts: CardToolOptions) {
  return tool({
    name: 'send_escalation_card',
    description:
      'DM the leader an escalation Adaptive Card when an owner hasn\'t replied to a follow-up. ' +
      'Called by the scheduler (not typically the LLM) after the escalation timeout elapses.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leaderAadObjectId: { type: 'string' },
        followupId: { type: 'string' },
        taskId: { type: 'string' },
        taskTitle: { type: 'string' },
        ownerName: { type: 'string' },
        hoursSinceReminder: { type: 'number' },
        dueDate: { type: ['string', 'null'] },
      },
      required: [
        'leaderAadObjectId',
        'followupId',
        'taskId',
        'taskTitle',
        'ownerName',
        'hoursSinceReminder',
        'dueDate',
      ],
    } as any,
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs ?? {}) as EscalationArgs;
      try {
        const card = buildEscalationCard(args);
        const { conversationId } = await sendCardToUser(opts, args.leaderAadObjectId, card, 'escalation');
        return JSON.stringify({ ok: true, conversationId });
      } catch (err) {
        return toolFail('send_escalation_card', err);
      }
    },
  });
}

// ─── 5. Task assignment card (agent → newly-assigned owner) ────────────────
// Sent immediately after planner_create_task so the owner learns about the
// task through a DM instead of only via Planner notifications (which they
// may miss if they don't have the plan open). Card links directly to the
// Planner task.
interface TaskAssignmentArgs {
  ownerAadObjectId: string;
  ownerName: string;
  taskId: string;
  taskTitle: string;
  taskDescription?: string | null;
  dueDate?: string | null;
  assignedByName?: string | null;
  meetingSubject?: string | null;
}

/** Build the tasks.office.com deep link, or undefined if we don't have the
 *  tenant id (button just gets omitted rather than sending a broken link). */
function buildPlannerTaskLink(taskId: string): string | undefined {
  const tenantId =
    process.env.TENANT_ID?.trim() ||
    process.env.AAD_APP_TENANT_ID?.trim() ||
    process.env.connections__service_connection__settings__tenantId?.trim();
  if (!tenantId || !taskId) return undefined;
  return `https://tasks.office.com/${encodeURIComponent(tenantId)}/Home/Task/${encodeURIComponent(taskId)}`;
}

function buildTaskAssignmentCard(args: TaskAssignmentArgs): object {
  const firstName = args.ownerName?.split(' ')[0] ?? 'there';
  const dueLabel = args.dueDate
    ? `Due ${new Date(args.dueDate).toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      })}`
    : 'No due date set';
  const link = buildPlannerTaskLink(args.taskId);

  const facts: Array<{ title: string; value: string }> = [
    { title: 'Due', value: dueLabel },
  ];
  if (args.assignedByName) facts.push({ title: 'Assigned by', value: args.assignedByName });
  if (args.meetingSubject) facts.push({ title: 'From meeting', value: args.meetingSubject });

  const body: any[] = [
    cardHeader('📋 New task assigned to you', 'From your Chief of Staff', {
      text: 'New',
      color: 'Accent',
    }),
    {
      type: 'TextBlock',
      text: `Hi ${firstName}, a new task has been assigned to you — please take a look.`,
      wrap: true,
      spacing: 'Medium',
    },
    {
      type: 'TextBlock',
      text: `**${args.taskTitle}**`,
      wrap: true,
      spacing: 'Small',
    },
    { type: 'FactSet', facts },
  ];

  if (args.taskDescription) {
    body.push({
      type: 'TextBlock',
      text: args.taskDescription.length > 500
        ? args.taskDescription.slice(0, 500) + '…'
        : args.taskDescription,
      wrap: true,
      isSubtle: true,
      spacing: 'Small',
    });
  }

  const actions: any[] = [];
  if (link) {
    actions.push({
      type: 'Action.OpenUrl',
      title: '📎 Open in Planner',
      url: link,
    });
  }
  // Also include a quick acknowledge so the owner can confirm without opening
  // Planner. Reuses the existing `ontrack` verb — actionRouter already handles
  // it (marks the follow-up as acknowledged / on track).
  actions.push(
    actionButton('✅ Got it', 'ontrack', { taskId: args.taskId })
  );

  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    body,
    actions,
  };
}

export function createTaskAssignmentTool(opts: CardToolOptions) {
  return tool({
    name: 'send_task_assignment_card',
    description:
      'DM a newly-assigned owner an Adaptive Card announcing a new Planner task. ' +
      'Call this immediately after planner_create_task for every non-decision task ' +
      'so the owner learns about it via Teams DM (not only via Planner). ' +
      'The card includes title, due date, description, and an "Open in Planner" button.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ownerAadObjectId: { type: 'string', description: 'AAD Object ID of the assignee (DM recipient).' },
        ownerName: { type: 'string', description: 'Owner display name for the greeting.' },
        taskId: { type: 'string', description: 'Planner task id returned by planner_create_task.' },
        taskTitle: { type: 'string', description: 'Human-readable task title.' },
        taskDescription: {
          type: ['string', 'null'],
          description: 'Optional short description / context to show under the title.',
        },
        dueDate: {
          type: ['string', 'null'],
          description: 'ISO due date (optional). Shown in the FactSet.',
        },
        assignedByName: {
          type: ['string', 'null'],
          description: 'Display name of who assigned it (usually the Leader). Shown in the FactSet.',
        },
        meetingSubject: {
          type: ['string', 'null'],
          description: 'Subject of the meeting this task came from, if any. Shown in the FactSet for context.',
        },
      },
      required: [
        'ownerAadObjectId',
        'ownerName',
        'taskId',
        'taskTitle',
        'taskDescription',
        'dueDate',
        'assignedByName',
        'meetingSubject',
      ],
    } as any,
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs ?? {}) as TaskAssignmentArgs;
      try {
        const card = buildTaskAssignmentCard(args);
        const { conversationId } = await sendCardToUser(
          opts,
          args.ownerAadObjectId,
          card,
          'task-assignment'
        );
        return JSON.stringify({ ok: true, conversationId });
      } catch (err) {
        return toolFail(
          'send_task_assignment_card',
          err,
          'Delivery attempted both Bot Framework proactive and Graph POST /chats as the agent user. If both failed, the recipient AAD is invalid OR the agent app is missing Chat.Create / Chat.ReadWrite delegated permissions (admin-consented).'
        );
      }
    },
  });
}

// ─── Public factory + a direct sender for the scheduler ────────────────────
export function createFollowupCardTools(opts: CardToolOptions) {
  return [
    createFollowupCheckInTool(opts),
    createExtensionRequestTool(opts),
    createBlockerMeetingTool(opts),
    createEscalationTool(opts),
    createTaskAssignmentTool(opts),
  ];
}

/** Programmatic escalation-card sender used by the scheduler's stale sweep.
 *  Bypasses the LLM entirely. */
export async function sendEscalationCardDirect(
  opts: CardToolOptions,
  args: EscalationArgs
): Promise<{ ok: boolean; error?: string }> {
  try {
    const card = buildEscalationCard(args);
    await sendCardToUser(opts, args.leaderAadObjectId, card, 'escalation');
    return { ok: true };
  } catch (err) {
    const e = err as any;
    const msg = e?.response?.data ?? e?.message ?? String(e);
    console.error('[sendEscalationCardDirect] failed:', msg);
    return { ok: false, error: String(msg) };
  }
}

/** Programmatic extension-request card sender for the deterministic extend
 *  flow (action router "Need more time" click / esc_extend). LLM-free. */
export async function sendExtensionRequestCardDirect(
  opts: CardToolOptions,
  args: ExtensionRequestArgs
): Promise<{ ok: boolean; conversationId?: string; error?: string }> {
  try {
    const card = buildExtensionRequestCard(args);
    const { conversationId } = await sendCardToUser(
      opts,
      args.leaderAadObjectId,
      card,
      'extension-request'
    );
    return { ok: true, conversationId };
  } catch (err) {
    const e = err as any;
    const msg = e?.response?.data ?? e?.message ?? String(e);
    console.error('[sendExtensionRequestCardDirect] failed:', msg);
    return { ok: false, error: String(msg) };
  }
}

/** Programmatic blocker-meeting card sender for the deterministic unblock flow
 *  (action router "I'm blocked" click). Same LLM-free pattern as escalation. */
export async function sendBlockerMeetingCardDirect(
  opts: CardToolOptions,
  args: BlockerMeetingArgs
): Promise<{ ok: boolean; conversationId?: string; error?: string }> {
  try {
    const card = buildBlockerMeetingCard(args);
    const { conversationId } = await sendCardToUser(
      opts,
      args.leaderAadObjectId,
      card,
      'blocker-meeting'
    );
    return { ok: true, conversationId };
  } catch (err) {
    const e = err as any;
    const msg = e?.response?.data ?? e?.message ?? String(e);
    console.error('[sendBlockerMeetingCardDirect] failed:', msg);
    return { ok: false, error: String(msg) };
  }
}

/** Send a plain-text DM to a user via the same proactive/Graph fallback path
 *  the card tools use. Handy when we want to notify without a card. */
export async function sendPlainDmToUser(
  opts: CardToolOptions,
  recipientAad: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    // Minimal card: single TextBlock. Cheaper than a full Adaptive Card but
    // still routes through the same proactive/Graph fallback.
    const card = {
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.5',
      body: [{ type: 'TextBlock', text, wrap: true }],
    };
    await sendCardToUser(opts, recipientAad, card, 'plain-dm');
    return { ok: true };
  } catch (err) {
    const e = err as any;
    const msg = e?.response?.data ?? e?.message ?? String(e);
    console.error('[sendPlainDmToUser] failed:', msg);
    return { ok: false, error: String(msg) };
  }
}
