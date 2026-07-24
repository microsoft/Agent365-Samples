// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Calendar operations for the Chase (MVP 3) flow.
 *
 * Implementation: drives the **A365 `mcp_CalendarTools`** MCP server via a
 * scenario-specific OpenAI Agent. The event is created on the *agent's* mailbox
 * (Scrum-Master-Assistant), not the SM's — which is the correct ownership model
 * for an AI teammate that runs its own ceremonies.
 *
 * Rationale for going through the LLM + MCP path instead of direct Graph:
 *   - No delegated-user Graph consent to manage.
 *   - Auth is handled by the A365 platform via the agentic token exchange.
 *   - Consistent with how every other tool in this sample is invoked.
 *
 * We use `outputType` with a Zod schema so the model returns structured JSON,
 * not free text. Fallback synthetic slots are still generated if the tool call
 * or LLM response is unusable.
 */

import { z } from 'zod';
import { DateTime } from 'luxon';
import { Agent, run } from '@openai/agents';
import { TurnContext, Authorization } from '@microsoft/agents-hosting';
import { McpToolRegistrationService } from '@microsoft/agents-a365-tooling-extensions-openai';

import { getModelName } from '../openai-config';

// --- public shapes (unchanged) -------------------------------------------

export interface MeetingSlot {
    startIso: string;
    endIso: string;
    label: string;
}

export interface Attendee {
    email: string;
    displayName?: string;
}

export interface CreatedEvent {
    id: string;
    webLink: string;
    /** Teams join URL when the calendar tool created an online meeting. */
    onlineMeetingUrl?: string | null;
    /** Number of attendees the calendar tool actually attached. */
    attendeeCount?: number;
}

// --- context threaded from the handler ------------------------------------

export interface CalendarContext {
    turnContext: TurnContext;
    authorization: Authorization;
    authHandlerName: string;
}

// --- module-level MCP tooling registration --------------------------------

const toolService = new McpToolRegistrationService();

/**
 * Build a scenario-specific Agent bound to the A365 MCP servers (which includes
 * `mcp_CalendarTools` from `ToolingManifest.json`).
 *
 * `outputType` requires a Zod object schema per the Agents SDK; we accept any
 * `ZodObject<any>` so callers can plug their own structured shape.
 */
async function buildCalendarAgent(
    cc: CalendarContext,
    instructions: string,
    outputType: z.ZodObject<any>,
): Promise<Agent<any, any>> {
    const agent = new Agent({
        name: 'Scrum Master — Calendar',
        model: getModelName(),
        instructions,
        outputType,
    });
    try {
        // The MCP service's typing pins the agent to the default text-output Agent
        // shape; with `outputType` set our Agent is a different generic instantiation,
        // so cast through `any` here. Runtime just needs the mcpServers array set.
        await toolService.addToolServersToAgent(
            agent as any,
            cc.authorization,
            cc.authHandlerName,
            cc.turnContext,
            process.env.BEARER_TOKEN || '',
        );
    } catch (err) {
        console.warn('[calendar] MCP registration warning:', (err as Error).message);
    }
    return agent as unknown as Agent<any, any>;
}

async function withServers<T>(agent: Agent<any, any>, fn: () => Promise<T>): Promise<T> {
    const servers = (agent as any).mcpServers as Array<{ connect(): Promise<void>; close(): Promise<void> }> | undefined;
    const connectAll = async () => {
        if (servers?.length) for (const s of servers) await s.connect().catch(() => { /* idempotent */ });
    };
    await connectAll();
    // Intentionally NO close() in a finally block. The Streamable-HTTP MCP session
    // that `mcp_CalendarTools` uses is meant to be long-lived and is reused across
    // agent turns. Closing it here caused subsequent calls (e.g. clicking "Book it"
    // after "Propose unblock meeting") to fail with:
    //   {"error":{"code":-32001,"message":"Session not found"}}
    // because the module-level McpToolRegistrationService handed the new agent
    // a reference to the already-closed transport.
    //
    // If the transport has gone idle server-side we still get -32001 — retry once
    // by re-connecting and re-running.
    try {
        return await fn();
    } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (msg.includes('Session not found') || msg.includes('-32001')) {
            console.warn('[calendar] MCP session lost — reconnecting and retrying once.');
            await connectAll();
            return await fn();
        }
        throw e;
    }
}

// --- findUnblockSlots -----------------------------------------------------

const SlotArraySchema = z.object({
    slots: z.array(z.object({
        startIso: z.string().describe('ISO-8601 datetime with timezone offset, e.g. 2026-07-14T15:30:00+05:30'),
        endIso: z.string().describe('ISO-8601 datetime with timezone offset'),
        label: z.string().describe('Human-friendly local time, e.g. "Mon 14 Jul, 3:30 PM IST"'),
    })).max(3),
});

export async function findUnblockSlots(
    cc: CalendarContext,
    attendees: Attendee[],
    durationMinutes: number,
    timezone: string,
    lookaheadHours = 48,
): Promise<MeetingSlot[]> {
    // Dedupe attendees (the same person may appear as owner + reporter + SM in
    // small teams / the POC — presenting the deduped list to the LLM is cleaner).
    const uniqueEmails = Array.from(new Set(attendees.map(a => a.email.toLowerCase()).filter(Boolean)));
    const nowIso = DateTime.now().setZone('UTC').toISO();
    const laterIso = DateTime.now().setZone('UTC').plus({ hours: lookaheadHours }).toISO();

    const instructions =
        `You are a scheduling assistant with access to the mcp_CalendarTools tools.\n` +
        `Your job is to propose meeting slots. Steps:\n` +
        `1. Use mcp_CalendarTools to find candidate meeting times (or free/busy).\n` +
        `2. Return **up to 3** distinct slot suggestions inside the requested window.\n` +
        `3. Each slot must be exactly ${durationMinutes} minutes long.\n` +
        `4. Prefer business hours in the ${timezone} timezone.\n` +
        `5. Do not invent times without checking availability when possible.\n`;

    const prompt =
        `Find up to 3 candidate ${durationMinutes}-minute meeting slots.\n` +
        `Attendees (email addresses): ${uniqueEmails.length ? uniqueEmails.join(', ') : '(no external attendees — schedule on the organiser only)'}\n` +
        `Window: ${nowIso} → ${laterIso}\n` +
        `Timezone for display labels: ${timezone}`;

    try {
        const agent = await buildCalendarAgent(cc, instructions, SlotArraySchema);
        const result = await withServers(agent, () => run(agent, prompt));
        const out = (result as any).finalOutput as z.infer<typeof SlotArraySchema> | undefined;
        const slots = out?.slots?.filter(s => s.startIso && s.endIso) ?? [];
        if (slots.length > 0) return slots;
    } catch (err) {
        console.warn('[calendar] findUnblockSlots MCP path failed, using fallback:', (err as Error).message);
    }
    return synthesizeFallbackSlots(durationMinutes, timezone);
}

function synthesizeFallbackSlots(durationMinutes: number, timezone: string): MeetingSlot[] {
    const nowUtc = DateTime.now().toUTC();
    const roundedStart = nowUtc.set({ minute: nowUtc.minute < 30 ? 30 : 0, second: 0, millisecond: 0 })
        .plus({ hours: nowUtc.minute < 30 ? 0 : 1 });
    const slots: MeetingSlot[] = [];
    for (let i = 1; i <= 3; i++) {
        const start = roundedStart.plus({ hours: i });
        const end = start.plus({ minutes: durationMinutes });
        slots.push({
            startIso: start.toISO() ?? '',
            endIso: end.toISO() ?? '',
            label: start.setZone(timezone).toFormat('ccc d LLL, h:mm a ZZZZ'),
        });
    }
    return slots;
}

// --- createUnblockMeeting -------------------------------------------------

const CreatedEventSchema = z.object({
    id: z.string().describe('The event id returned by the calendar tool.'),
    webLink: z.string().describe('A URL to open the event in Outlook / Teams calendar.'),
    onlineMeetingUrl: z.string().nullable().optional()
        .describe('The Teams / online-meeting join URL if one was created. Null / empty is acceptable.'),
    attendeeCount: z.number().int().min(0).optional()
        .describe('Number of attendees actually attached to the created event.'),
});

export async function createUnblockMeeting(cc: CalendarContext, opts: {
    subject: string;
    body: string;              // may contain simple HTML
    startIso: string;
    endIso: string;
    attendees: Attendee[];
    timezone: string;
}): Promise<CreatedEvent> {
    const uniqueAttendees = dedupeAttendees(opts.attendees);

    // Hardened instructions: we saw the earlier attempt create the event but
    // WITHOUT attendees or a Teams meeting link. Being explicit fixes both.
    const instructions =
        `You are a calendar assistant with access to the mcp_CalendarTools tools.\n` +
        `On this turn, your ONLY task is to create ONE calendar event using the calendar create-event tool. Follow every rule:\n\n` +
        `1. **Attendees are mandatory** — pass every email listed in the user message to the tool's attendees parameter. Do not drop or de-duplicate them; the caller has already deduped.\n` +
        `2. **Turn the event into a Teams online meeting** — the calendar tool exposes flags such as \`isOnlineMeeting\` / \`onlineMeetingProvider\` (=\`teamsForBusiness\`). Set them both. If the tool has a "createOnlineMeeting" or similar sub-option, invoke it. The resulting event MUST have a Teams join link.\n` +
        `3. Use the exact subject, body (HTML allowed), start, end, and timezone from the user message. Do not paraphrase.\n` +
        `4. **The event is organised by YOU (the agent)** — the caller is an attendee, not the organiser.\n` +
        `5. After creation, verify the event was really saved (call get / read tool if available). Return the id, the webLink, the online-meeting join URL if any, and the attendee count.\n` +
        `6. If the tool call fails, return \`{ id: "error:<message>", webLink: "" }\`.\n` +
        `\nDo not chit-chat, apologise, or emit commentary. Return only the structured JSON.`;

    const attendeeLines = uniqueAttendees.length
        ? uniqueAttendees.map(a => `- ${a.email}${a.displayName ? ` (${a.displayName})` : ''}`).join('\n')
        : '(no attendees other than the organiser)';

    const prompt =
        `Create the following meeting NOW using the calendar tool:\n` +
        `Subject: ${opts.subject}\n` +
        `Start (ISO): ${opts.startIso}\n` +
        `End (ISO): ${opts.endIso}\n` +
        `Timezone: ${opts.timezone}\n` +
        `Attendees:\n${attendeeLines}\n` +
        `Body (HTML):\n${opts.body}`;

    const agent = await buildCalendarAgent(cc, instructions, CreatedEventSchema);
    const result = await withServers(agent, () => run(agent, prompt));
    const out = (result as any).finalOutput as z.infer<typeof CreatedEventSchema> | undefined;
    if (!out || !out.webLink) {
        throw new Error(`Calendar tool returned no event link. Raw: ${JSON.stringify(out)}`);
    }
    return {
        id: out.id,
        webLink: out.webLink,
        onlineMeetingUrl: out.onlineMeetingUrl ?? null,
        attendeeCount: out.attendeeCount,
    };
}

function dedupeAttendees(attendees: Attendee[]): Attendee[] {
    const seen = new Set<string>();
    const out: Attendee[] = [];
    for (const a of attendees) {
        const key = (a.email || '').toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(a);
    }
    return out;
}

