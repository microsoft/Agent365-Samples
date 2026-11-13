// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Code-level guard for the WorkIQ Mail and Calendar MCP servers.
 *
 * Recipients: the prompt says the agent may only email / invite the current user (and their manager
 * when the user asks), but a prompt is not a control: an email body or quoted history can try to steer
 * the model. Every non-read tool call is therefore checked here, before it reaches the server: each
 * email address in the arguments must belong to the allowed set (the sender's own addresses, plus the
 * manager only when the sender's own message asks for the manager). Anything else — an unknown
 * address, a recipient field we cannot verify, forward/reply tools — is refused and the model is told
 * why. The allowed set fails closed: if it cannot be resolved, nothing with a recipient is sent.
 *
 * Shared mailbox: every employee talks to the same Career Coach mailbox and calendar, which hold other
 * employees' coaching messages, completion reports and invites. So the Mail server exposes only the
 * operations that send (or draft) a message; reading, searching, updating or deleting mail is not
 * available at all. Calendar reads are allowed only when they name verified addresses (free/busy style
 * lookups for the employee), never as an open listing of the shared calendar.
 */

import type { MCPServer } from '@openai/agents';
import type { Client as MsGraphClient } from '@microsoft/microsoft-graph-client';

const READ_TOOL = /^(get|list|search|find|read|query|fetch|download|retrieve|lookup)/i;
const WRITE_WORD = /send|create|update|draft|invite|schedule|forward|reply|add|post|move|delete|remove|accept|decline|respond|cancel|set|patch|write/i;

const lastSegment = (name: string): string => name.split(/[_.\-]/).filter(Boolean).pop() ?? name;

/** Read-only by name: the last name segment starts with a read verb and contains no write verb. */
export function isReadToolName(name: string): boolean {
    const base = lastSegment(name);
    return READ_TOOL.test(base) && !WRITE_WORD.test(base);
}

export type MailServerKind = 'mail' | 'calendar';

export function serverKindOf(serverName: string): MailServerKind {
    return /calendar/i.test(serverName) ? 'calendar' : 'mail';
}

// The only Mail operations the scenario needs: send a message, or create a draft. "sendDraft…" is
// excluded because it sends an existing (possibly another employee's) draft by id.
const MAIL_ALLOWED = /^(send(?!draft)|create(draft|message))/i;

/** Whether a tool on the shared Mail server may be used at all. */
export function mailToolAllowed(toolName: string): boolean {
    return MAIL_ALLOWED.test(lastSegment(toolName));
}

const EMAIL = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const RECIPIENT_KEY = /^(to|cc|bcc|recipients?|toRecipients|ccRecipients|bccRecipients|attendees?|requiredAttendees|optionalAttendees|emailAddress|address|emails?)$/i;
const BLOCKED_TOOL = /forward|reply/i;

export interface RecipientSources {
    graph: MsGraphClient;
    userId: string;
    /** The sender's own message (not quoted history): the manager is allowed only if it asks for them. */
    userText: string;
}

/** True when the sender's own message asks for their manager to be included. */
export function asksForManager(userText: string): boolean {
    return /\bmanager\b/i.test(userText);
}

export async function resolveAllowedRecipients({ graph, userId, userText }: RecipientSources): Promise<Set<string>> {
    const allowed = new Set<string>();
    const add = (value: unknown): void => {
        if (typeof value === 'string' && value.trim()) allowed.add(value.trim().toLowerCase().replace(/^smtp:/i, ''));
    };
    try {
        const me: any = await graph.api(`/users/${encodeURIComponent(userId)}`).select('mail,userPrincipalName,otherMails,proxyAddresses').get();
        add(me?.mail);
        add(me?.userPrincipalName);
        for (const m of me?.otherMails ?? []) add(m);
        for (const p of me?.proxyAddresses ?? []) if (/^smtp:/i.test(String(p))) add(p);
        if (asksForManager(userText)) {
            const manager: any = await graph.api(`/users/${encodeURIComponent(userId)}/manager`).select('mail,userPrincipalName').get().catch(() => null);
            add(manager?.mail);
            add(manager?.userPrincipalName);
        }
    } catch (err) {
        console.warn('[WorkIQ] Could not resolve the allowed mail recipients — mail/calendar writes with recipients are blocked this turn:', (err as any)?.message ?? err);
        allowed.clear();
    }
    return allowed;
}

/** Collects every address in the arguments and flags recipient fields that carry no verifiable address. */
export function inspectRecipients(args: unknown): { emails: string[]; unverifiable: boolean } {
    const emails = new Set<string>();
    let unverifiable = false;
    const walk = (value: unknown, inRecipientField: boolean): void => {
        if (typeof value === 'string') {
            const found = value.match(EMAIL) ?? [];
            for (const e of found) emails.add(e.toLowerCase());
            if (inRecipientField && value.trim() && found.length === 0) unverifiable = true;
        } else if (Array.isArray(value)) {
            for (const v of value) walk(v, inRecipientField);
        } else if (value && typeof value === 'object') {
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, inRecipientField || RECIPIENT_KEY.test(k));
        }
    };
    walk(args, false);
    return { emails: [...emails], unverifiable };
}

/** Why a call must be refused, or null when it is allowed. */
export async function recipientViolation(
    toolName: string,
    args: unknown,
    resolveAllowed: () => Promise<Set<string>>,
    kind: MailServerKind = 'calendar',
): Promise<string | null> {
    if (kind === 'mail') {
        // The shared mailbox holds every employee's messages: only sending / drafting is available.
        if (!mailToolAllowed(toolName)) {
            return 'Only sending an email to the current user is available. Reading, searching, replying to, forwarding or changing mail is not, because the mailbox is shared by every employee.';
        }
    } else if (isReadToolName(toolName)) {
        // Calendar reads: only free/busy-style lookups that name verified addresses, never an open listing.
        const { emails, unverifiable } = inspectRecipients(args);
        if (emails.length === 0 || unverifiable) {
            return 'Calendar lookups must name the current user (the calendar is shared by every employee, so it can\'t be listed or searched).';
        }
        const allowedForRead = await resolveAllowed();
        return emails.every((e) => allowedForRead.has(e))
            ? null
            : 'Calendar lookups are limited to the current user (and their manager only when the user asked for the manager).';
    }
    if (BLOCKED_TOOL.test(toolName)) return 'Forwarding and replying from the mailbox are not available — the app sends the reply itself.';
    const { emails, unverifiable } = inspectRecipients(args);
    if (unverifiable) return 'A recipient could not be verified; use the current user\'s email address.';
    if (emails.length === 0) return null;
    const allowed = await resolveAllowed();
    const outsiders = emails.filter((e) => !allowed.has(e));
    return outsiders.length
        ? 'Recipients are limited to the current user (and their manager only when the user asked for the manager).'
        : null;
}

/**
 * Wraps `server.callTool` so every call is checked first. Blocked calls return a text result to the model.
 * `onExecuted` fires just before an allowed write-like call is made — even if the call then fails, since
 * a network error can arrive after the server already acted — so the caller knows an external action
 * may have happened and must not replay the run.
 */
export function guardRecipients(
    server: MCPServer,
    resolveAllowed: () => Promise<Set<string>>,
    onExecuted?: (toolName: string) => void,
): void {
    const original = server.callTool.bind(server);
    const kind = serverKindOf(server.name);
    let cached: Promise<Set<string>> | undefined;
    const allowedOnce = (): Promise<Set<string>> => (cached ??= resolveAllowed());
    server.callTool = async (toolName, args, meta) => {
        const violation = await recipientViolation(toolName, args, allowedOnce, kind);
        if (violation) {
            console.warn(`[WorkIQ] Blocked '${toolName}' on '${server.name}': ${violation}`);
            return [{ type: 'text', text: `BLOCKED: ${violation}` }] as any;
        }
        if (!isReadToolName(toolName)) onExecuted?.(toolName);
        return original(toolName, args, meta);
    };
    if (kind === 'mail') {
        // Hide the tools that can't be used, so the model never plans around them.
        server.toolFilter = async (_ctx, tool) => mailToolAllowed(tool.name);
    }
}
