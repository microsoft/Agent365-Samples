// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// The only place caller/agent identity keys are built. Every key is scoped by tenant +
// recipient agent instance and uses a stable caller id (AAD object id or a verified UPN).
// Display names are never used: they are not unique and are user-controlled.
import type { TurnContext } from '@microsoft/agents-hosting';

const norm = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

export function isEmailLike(v: unknown): v is string {
  return typeof v === 'string' && !/^\d+:/.test(v.trim()) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

// Tenant + recipient agent instance (agentic app id + agentic user id).
export function agentScopeKey(ctx: TurnContext): string | undefined {
  const a: any = ctx.activity;
  const tenant = norm(a?.conversation?.tenantId ?? a?.recipient?.tenantId ?? a?.channelData?.tenant?.id);
  const agent = norm(a?.recipient?.agenticAppId ?? a?.recipient?.id);
  const agentUser = norm(a?.recipient?.agenticUserId);
  return tenant && agent ? `t:${tenant}|a:${agent}|u:${agentUser}` : undefined;
}

export function callerAadObjectId(ctx: TurnContext): string | undefined {
  return norm((ctx.activity?.from as any)?.aadObjectId) || undefined;
}

export function callerAadKey(ctx: TurnContext): string | undefined {
  const scope = agentScopeKey(ctx);
  const oid = callerAadObjectId(ctx);
  return scope && oid ? `${scope}|aad:${oid}` : undefined;
}

export function callerUpnKey(ctx: TurnContext, upn: string | undefined): string | undefined {
  const scope = agentScopeKey(ctx);
  return scope && isEmailLike(upn) ? `${scope}|upn:${norm(upn)}` : undefined;
}

// UPN carried by the JWT-validated agents channel itself (Word / email notifications put it in
// from.id). Ordinary Teams turns carry an MRI there, so they never match.
export function activityUpn(ctx: TurnContext): string | undefined {
  const channel = norm(ctx.activity?.channelId);
  const id = (ctx.activity?.from as any)?.id;
  return channel.startsWith('agents') && isEmailLike(id) ? norm(id) : undefined;
}

export function stableCallerKeys(ctx: TurnContext, verifiedUpn?: string): string[] {
  return [callerAadKey(ctx), callerUpnKey(ctx, verifiedUpn ?? activityUpn(ctx))]
    .filter((k): k is string => !!k);
}

// Small in-memory map with TTL + size bound so warm Lambda instances can't grow it without limit.
// In-memory only: a cold start forgets everything; production should use durable storage keyed the same way.
export class BoundedTtlMap<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(private readonly ttlMs: number, private readonly maxEntries = 1000) {}

  get(key: string): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
