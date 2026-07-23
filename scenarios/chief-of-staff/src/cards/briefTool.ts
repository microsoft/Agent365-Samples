// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// send_brief_card — custom tool exposed to the LLM. Given structured brief
// data (priorities / watch list / calendar), builds an Adaptive Card and DMs
// it to the leader via Bot Framework proactive messaging.
//
// Flow:
//   1. Build the Adaptive Card JSON server-side (deterministic — LLM only
//      passes simple string arrays).
//   2. Look up the recipient's cached ConversationReference (populated the
//      first time they DM the agent — see state/conversationRefs.ts).
//   3. adapter.continueConversation → ctx.sendActivity with the card attached.
//
// Why not Graph POST /chats/{id}/messages? With app-permission tokens Graph
// rejects that call unless we hold Teamwork.Migrate.All — an import-only role
// meant for tenant migrations, not real-time bot messaging. The proactive
// route via the Bot Framework channel is the supported path for agents.

import { tool } from '@openai/agents';
import { Authorization, CloudAdapter, TurnContext } from '@microsoft/agents-hosting';
import { getBotAppId, sendCardProactively } from './proactiveSend';
import { hasConversationRef } from '../state/conversationRefs';

export interface BriefToolOptions {
  authorization: Authorization;
  context: TurnContext;
  authHandlerName: string;
}

/**
 * Structured row for a Planner task in the brief. Preferred over the
 * legacy string form because it lets the card build a properly-aligned
 * ColumnSet (badge · title · owner · due) instead of a single Markdown
 * blob.
 */
export interface BriefTaskItem {
  band: 0 | 1 | 2 | 3;
  title: string;
  taskId?: string;
  taskUrl?: string;
  ownerName?: string | null;
  /** Short suffix — "due Thu 16 Jul", "2d overdue", "no due date set". */
  meta?: string;
}

/** Structured row for a calendar event. */
export interface BriefCalendarItem {
  /** Rendered day/time string, e.g. "Wed 3:00 PM IST". */
  when: string;
  subject: string;
}

export interface BriefCardArgs {
  leaderAadObjectId: string;
  headline?: string | null;
  /** Legacy string form — kept for the LLM tool path. */
  priorities: string[];
  watchList: string[];
  calendar: string[];
  /** Preferred structured form — used by the deterministic brief pipeline. */
  priorityItems?: BriefTaskItem[];
  watchItems?: BriefTaskItem[];
  calendarItems?: BriefCalendarItem[];
}

// ─── Card builder ──────────────────────────────────────────────────────────
/**
 * Drop obviously-broken lines coming from LLM tool-call corruption
 * (max-iteration truncation, sentinel leakage, JSON scaffolding). Keeps
 * the card readable even when gpt-4o's arguments come back malformed.
 * Also collapses whitespace and trims to a reasonable max length.
 */
function sanitizeBriefLine(line: unknown): string | null {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  // Reject known LLM/Foundry sentinels and JSON-scaffolding fragments.
  const junkPatterns = [
    /Truncated_ITERATION/i,
    /systemMessage/i,
    /companyBloc/i,
    /^[\]\}\)\.\,\s#]+$/,        // just punctuation
    /^\[\[\]\]/,                  // starts with [[ ]] scaffolding
    /^\{\{/,                      // starts with {{
    /\]\]\}\}/,                   // contains ]]}}
  ];
  if (junkPatterns.some((r) => r.test(trimmed))) return null;
  // Collapse whitespace and cap at 200 chars.
  const collapsed = trimmed.replace(/\s+/g, ' ');
  return collapsed.length > 200 ? collapsed.slice(0, 200) + '…' : collapsed;
}

export function buildBriefAdaptiveCard(args: BriefCardArgs): object {
  const now = new Date();
  const dateLong = now.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const timeShort = now.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });

  // ── P-band styling ──────────────────────────────────────────────────────
  // Map P0-P3 to Adaptive-Card semantic colors + short pill label.
  const bandStyle = (band: 0 | 1 | 2 | 3): { color: string; label: string } => {
    switch (band) {
      case 0: return { color: 'Attention', label: 'P0' };  // red
      case 1: return { color: 'Warning',   label: 'P1' };  // amber
      case 2: return { color: 'Accent',    label: 'P2' };  // blue
      default: return { color: 'Default',  label: 'P3' };  // grey
    }
  };

  /** Renders one Planner-task row as a ColumnSet:
   *    [ P0 ]  Task title (link)                     due Thu 16 Jul
   *            @Owner
   */
  const taskRow = (item: BriefTaskItem): object => {
    const style = bandStyle(item.band);
    const title = (item.title ?? '').trim() || '(untitled)';
    const linked = item.taskUrl ? `[${title}](${item.taskUrl})` : title;
    return {
      type: 'ColumnSet',
      spacing: 'Small',
      columns: [
        {
          type: 'Column',
          width: 'auto',
          verticalContentAlignment: 'Top',
          items: [
            {
              type: 'TextBlock',
              text: style.label,
              weight: 'Bolder',
              size: 'Small',
              color: style.color,
              wrap: false,
            },
          ],
        },
        {
          type: 'Column',
          width: 'stretch',
          items: [
            {
              type: 'TextBlock',
              text: linked,
              wrap: true,
              size: 'Default',
            },
            ...(item.ownerName
              ? [
                  {
                    type: 'TextBlock',
                    text: `@${item.ownerName}`,
                    wrap: false,
                    size: 'Small',
                    isSubtle: true,
                    spacing: 'None',
                  },
                ]
              : []),
          ],
        },
        ...(item.meta
          ? [
              {
                type: 'Column',
                width: 'auto',
                verticalContentAlignment: 'Top',
                items: [
                  {
                    type: 'TextBlock',
                    text: item.meta,
                    wrap: false,
                    size: 'Small',
                    isSubtle: true,
                    horizontalAlignment: 'Right',
                  },
                ],
              },
            ]
          : []),
      ],
    };
  };

  /** Renders one calendar row: [ 3:00 PM IST ]  Subject */
  const calendarRow = (item: BriefCalendarItem): object => ({
    type: 'ColumnSet',
    spacing: 'Small',
    columns: [
      {
        type: 'Column',
        width: 'auto',
        items: [
          {
            type: 'TextBlock',
            text: item.when,
            weight: 'Bolder',
            size: 'Small',
            color: 'Accent',
            wrap: false,
          },
        ],
      },
      {
        type: 'Column',
        width: 'stretch',
        items: [
          {
            type: 'TextBlock',
            text: item.subject || '(no subject)',
            wrap: true,
            size: 'Default',
          },
        ],
      },
    ],
  });

  /** Legacy string-row fallback for the LLM tool path. */
  const stringRow = (line: string): object => ({
    type: 'TextBlock',
    text: `• ${line}`,
    wrap: true,
    spacing: 'Small',
  });

  /** Builds a section header + separator + row items. Section is HIDDEN
   *  when it has no rows — avoids empty-header clutter. */
  const section = (
    label: string,
    rows: object[],
    countBadge?: number
  ): object[] => {
    if (rows.length === 0) return [];
    const header: any = {
      type: 'ColumnSet',
      separator: true,
      spacing: 'Medium',
      columns: [
        {
          type: 'Column',
          width: 'stretch',
          items: [
            {
              type: 'TextBlock',
              text: label,
              weight: 'Bolder',
              size: 'Medium',
              wrap: false,
            },
          ],
        },
      ],
    };
    if (typeof countBadge === 'number') {
      header.columns.push({
        type: 'Column',
        width: 'auto',
        items: [
          {
            type: 'TextBlock',
            text: `${countBadge}`,
            weight: 'Bolder',
            size: 'Small',
            isSubtle: true,
            horizontalAlignment: 'Right',
          },
        ],
      });
    }
    return [header, ...rows];
  };

  // Prefer structured items when present; fall back to legacy strings.
  const priorityRows: object[] =
    args.priorityItems && args.priorityItems.length > 0
      ? args.priorityItems.map(taskRow)
      : (args.priorities ?? [])
          .map(sanitizeBriefLine)
          .filter((s): s is string => !!s)
          .map(stringRow);

  const watchRows: object[] =
    args.watchItems && args.watchItems.length > 0
      ? args.watchItems.map(taskRow)
      : (args.watchList ?? [])
          .map(sanitizeBriefLine)
          .filter((s): s is string => !!s)
          .map(stringRow);

  const calendarRows: object[] =
    args.calendarItems && args.calendarItems.length > 0
      ? args.calendarItems.map(calendarRow)
      : (args.calendar ?? [])
          .map(sanitizeBriefLine)
          .filter((s): s is string => !!s)
          .map(stringRow);

  const totalCount = priorityRows.length + watchRows.length + calendarRows.length;

  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    body: [
      // ── Header ─────────────────────────────────────────────────────────
      {
        type: 'ColumnSet',
        columns: [
          {
            type: 'Column',
            width: 'stretch',
            items: [
              {
                type: 'TextBlock',
                text: args.headline?.trim() || 'Daily Brief',
                weight: 'Bolder',
                size: 'Large',
                wrap: true,
              },
              {
                type: 'TextBlock',
                text: `${dateLong}  ·  ${timeShort}`,
                isSubtle: true,
                size: 'Small',
                spacing: 'None',
                wrap: false,
              },
            ],
          },
          {
            type: 'Column',
            width: 'auto',
            verticalContentAlignment: 'Center',
            items: [
              {
                type: 'TextBlock',
                text: 'Chief of Staff',
                weight: 'Bolder',
                size: 'Small',
                color: 'Accent',
                isSubtle: false,
                horizontalAlignment: 'Right',
              },
            ],
          },
        ],
      },
      // ── Sections ───────────────────────────────────────────────────────
      ...section('Priorities', priorityRows, priorityRows.length),
      ...section('Risks & blockers', watchRows, watchRows.length),
      ...section('Upcoming meetings', calendarRows, calendarRows.length),
      // ── Footer ─────────────────────────────────────────────────────────
      ...(totalCount > 0
        ? [
            {
              type: 'TextBlock',
              text: 'Reply to me for a deep-dive on any item, or ask "what changed?"',
              isSubtle: true,
              size: 'Small',
              spacing: 'Large',
              separator: true,
              wrap: true,
            },
          ]
        : []),
    ],
  };
}

// ─── Graph helpers ─────────────────────────────────────────────────────────
// ─── Tool factory ──────────────────────────────────────────────────────────
export function createBriefCardTool(opts: BriefToolOptions) {
  return tool({
    name: 'send_brief_card',
    description:
      'DM the leader an Adaptive Card with today\'s brief (Priorities, Watch, Calendar). ' +
      'Use this once you have gathered the data via planner_list_tasks + mcp_CalendarTools — ' +
      'pass short one-line strings for each item; the card is rendered server-side.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leaderAadObjectId: {
          type: 'string',
          description: 'AAD Object ID of the leader (recipient of the DM).',
        },
        headline: {
          type: ['string', 'null'],
          description: 'Card headline. Defaults to "Your brief — <today>".',
        },
        priorities: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Ordered list of top priorities for the day. Keep each line short (≤80 chars).',
        },
        watchList: {
          type: 'array',
          items: { type: 'string' },
          description: 'Risks / blockers / past-due items to keep an eye on.',
        },
        calendar: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Upcoming meetings ("2 PM — Board Review", "Tomorrow 10 AM — Q1 Planning").',
        },
      },
      required: ['leaderAadObjectId', 'headline', 'priorities', 'watchList', 'calendar'],
    } as any,
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs ?? {}) as BriefCardArgs;
      try {
        if (!args.leaderAadObjectId) {
          return JSON.stringify({ ok: false, error: 'leaderAadObjectId is required' });
        }
        // Sanitize once and log what the LLM actually decided to send.
        const cleanPriorities = (args.priorities ?? [])
          .map(sanitizeBriefLine)
          .filter((s): s is string => !!s);
        const cleanWatch = (args.watchList ?? [])
          .map(sanitizeBriefLine)
          .filter((s): s is string => !!s);
        const cleanCalendar = (args.calendar ?? [])
          .map(sanitizeBriefLine)
          .filter((s): s is string => !!s);
        console.log(
          '[send_brief_card] args:',
          JSON.stringify({
            leader: args.leaderAadObjectId,
            headline: args.headline ?? null,
            counts: {
              priorities: cleanPriorities.length,
              watch: cleanWatch.length,
              calendar: cleanCalendar.length,
            },
            priorities: cleanPriorities,
            watchList: cleanWatch,
            calendar: cleanCalendar,
          })
        );
        // Guard: if everything is empty, don't DM an empty card — that just
        // looks broken. Return so the next cron can try again.
        if (
          cleanPriorities.length === 0 &&
          cleanWatch.length === 0 &&
          cleanCalendar.length === 0
        ) {
          console.warn(
            '[send_brief_card] all sections empty — skipping DM (LLM produced no items).'
          );
          return JSON.stringify({
            ok: false,
            error: 'empty-brief',
            hint:
              'All three sections were empty. Not sending an empty card. If tasks exist, revisit filter logic.',
          });
        }
        if (!hasConversationRef(args.leaderAadObjectId)) {
          const hint =
            "The leader hasn't DM'd the agent yet, so we don't have a ConversationReference to reach them proactively. " +
            'Ask them to send any Teams message to the agent once, then retry — or fall back to mcp_TeamsServer plain-text DM.';
          console.error('[send_brief_card] no cached conv ref for', args.leaderAadObjectId);
          return JSON.stringify({ ok: false, error: 'no-conversation-ref', hint });
        }
        const card = buildBriefAdaptiveCard({
          ...args,
          priorities: cleanPriorities,
          watchList: cleanWatch,
          calendar: cleanCalendar,
        });
        const adapter = (opts.context as any).adapter as CloudAdapter;
        const { conversationId } = await sendCardProactively({
          adapter,
          botAppId: getBotAppId(),
          recipientAad: args.leaderAadObjectId,
          card,
        });
        return JSON.stringify({
          ok: true,
          conversationId,
          sections: {
            priorities: args.priorities?.length ?? 0,
            watchList: args.watchList?.length ?? 0,
            calendar: args.calendar?.length ?? 0,
          },
        });
      } catch (err) {
        const e = err as any;
        const msg = e?.response?.data ?? e?.message ?? String(e);
        console.error('[send_brief_card] failed:', msg);
        return JSON.stringify({
          ok: false,
          error: msg,
          hint:
            'If the recipient has never DM\'d the agent, we cannot proactively reach them. Fall back to mcp_TeamsServer plain-text DM.',
        });
      }
    },
  });
}

