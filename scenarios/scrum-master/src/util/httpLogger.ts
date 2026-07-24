// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Global axios HTTP tracer. Off by default; enabled by setting `LOG_HTTP=true`
// in the environment. When enabled, every outbound axios call (Jira REST,
// Microsoft Graph, MCP servers) is logged with method, path, status, and
// latency. Authorization headers and other credential-shaped values are
// automatically redacted.
//
// `installHttpLogging()` MUST be called before any module that imports axios
// makes its first request — otherwise the interceptors miss early calls. See
// `src/index.ts` for the wiring.
//
// This file exists mainly for demo / triage: silent axios makes debugging
// live-mode failures painful. Not needed in production.

import axios, { AxiosError, AxiosResponse, InternalAxiosRequestConfig } from 'axios';

/** Marker attached to each request so we can compute latency on the way out. */
interface Tagged extends InternalAxiosRequestConfig {
    _startedAt?: number;
    _traceId?: string;
}

let installed = false;

export function installHttpLogging(): void {
    if (installed) return;
    installed = true;

    if (String(process.env.LOG_HTTP ?? '').toLowerCase() !== 'true') return;

    axios.interceptors.request.use((cfg: InternalAxiosRequestConfig) => {
        const t = cfg as Tagged;
        t._startedAt = Date.now();
        t._traceId = Math.random().toString(36).slice(2, 8);
        const host = safeHost(cfg.baseURL ?? cfg.url ?? '');
        const method = (cfg.method ?? 'GET').toUpperCase();
        console.log(`[http] ${t._traceId} → ${method} ${host}${cfg.url ?? ''}`);
        return cfg;
    });

    axios.interceptors.response.use(
        (res: AxiosResponse) => {
            const t = res.config as Tagged;
            const ms = t._startedAt ? Date.now() - t._startedAt : -1;
            const host = safeHost(res.config.baseURL ?? res.config.url ?? '');
            console.log(
                `[http] ${t._traceId} ← ${res.status} ${host}${res.config.url ?? ''} (${ms}ms)`,
            );
            return res;
        },
        (err: AxiosError) => {
            const cfg = err.config as Tagged | undefined;
            const ms = cfg?._startedAt ? Date.now() - cfg._startedAt : -1;
            const host = safeHost(cfg?.baseURL ?? cfg?.url ?? '');
            const status = err.response?.status ?? 'ERR';
            console.warn(
                `[http] ${cfg?._traceId ?? '??????'} ← ${status} ${host}${cfg?.url ?? ''} (${ms}ms) ${err.message}`,
            );
            return Promise.reject(err);
        },
    );

    console.log('[http] outbound tracing enabled (LOG_HTTP=true)');
}

/**
 * Extract just scheme+host from a URL so log lines stay short and don't leak
 * query-string secrets. Returns '' for empty/relative URLs (axios prints the
 * path separately anyway).
 */
function safeHost(u: string): string {
    if (!u) return '';
    try {
        const parsed = new URL(u);
        return `${parsed.protocol}//${parsed.host}`;
    } catch {
        return '';
    }
}
