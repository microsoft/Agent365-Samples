// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * The agent's own identity (tenant, agent instance, agentic user), remembered so background work —
 * the Graph change subscription and the notification row scan, which have no user turn — can mint
 * the agent user's Graph token with `connection.getAgenticUserToken(...)`, exactly as the per-turn
 * agentic auth handler does.
 *
 * The ids arrive on every turn (`activity.recipient`), so they are captured from the first message
 * and persisted to `.agent-identity.json` (git-ignored, no secrets). A hosted deployment can instead
 * set AGENT_INSTANCE_ID + AGENT_USER_ID (+ the tenant from the connection settings) so the
 * subscription can start before anyone has chatted with the agent.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface AgentIdentity {
    tenantId: string;
    agentInstanceId: string;
    agenticUserId: string;
}

const FILE = path.resolve(process.cwd(), '.agent-identity.json');
let cached: AgentIdentity | null | undefined;
const listeners: Array<() => void> = [];

function fromEnv(): AgentIdentity | null {
    const agentInstanceId = (process.env.AGENT_INSTANCE_ID || '').trim();
    const agenticUserId = (process.env.AGENT_USER_ID || '').trim();
    const tenantId = (process.env.connections__service_connection__settings__tenantId || '').trim();
    return agentInstanceId && agenticUserId && tenantId ? { tenantId, agentInstanceId, agenticUserId } : null;
}

function readFile(): AgentIdentity | null {
    try {
        if (!fs.existsSync(FILE)) return null;
        const parsed = JSON.parse(fs.readFileSync(FILE, 'utf-8')) as Partial<AgentIdentity>;
        return parsed.tenantId && parsed.agentInstanceId && parsed.agenticUserId
            ? { tenantId: parsed.tenantId, agentInstanceId: parsed.agentInstanceId, agenticUserId: parsed.agenticUserId }
            : null;
    } catch {
        return null;
    }
}

/** The configured (env) identity wins; otherwise the one captured from a turn. */
export function getAgentIdentity(): AgentIdentity | null {
    const configured = fromEnv();
    if (configured) return configured;
    if (cached === undefined) cached = readFile();
    return cached;
}

/** Called when the identity is first learned or changes (e.g. a new agent instance). */
export function onAgentIdentityChange(listener: () => void): void {
    listeners.push(listener);
}

/** Captures the identity from a turn's activity. Returns true when it was new or changed. */
export function rememberAgentIdentity(activity: any): boolean {
    const recipient = activity?.recipient;
    const agentInstanceId = String(recipient?.agenticAppId ?? '').trim();
    const agenticUserId = String(recipient?.agenticUserId ?? '').trim();
    const tenantId = String(recipient?.tenantId ?? activity?.conversation?.tenantId ?? '').trim();
    if (!agentInstanceId || !agenticUserId || !tenantId) return false;

    const next: AgentIdentity = { tenantId, agentInstanceId, agenticUserId };
    const current = getAgentIdentity();
    if (current && current.tenantId === tenantId && current.agentInstanceId === agentInstanceId && current.agenticUserId === agenticUserId) {
        return false;
    }
    cached = next;
    try {
        fs.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf-8');
    } catch (err) {
        console.warn('[agent-identity] Could not persist the agent identity (non-fatal):', (err as any)?.message ?? err);
    }
    console.log('[agent-identity] Captured the agent identity from a turn — background Graph work can now run as the agent user.');
    for (const listener of listeners) {
        try { listener(); } catch (err) { console.warn('[agent-identity] listener failed:', (err as any)?.message ?? err); }
    }
    return true;
}
