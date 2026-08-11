// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Installs global axios interceptors that log every HTTP request + response
// when LOG_HTTP=true. Useful for debugging Graph API calls end-to-end.
//
// Auth headers, tokens, and secrets are always redacted.

import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';
import { log } from './logger';

let installed = false;

function urlOf(cfg: AxiosRequestConfig): string {
  const base = cfg.baseURL ?? '';
  const path = cfg.url ?? '';
  return path.startsWith('http') ? path : `${base}${path}`;
}

function redactHeaders(h: any): any {
  if (!h) return h;
  const out: any = { ...h };
  for (const k of Object.keys(out)) {
    if (/authorization|cookie|token|api[-_]?key/i.test(k)) out[k] = '<redacted>';
  }
  return out;
}

function pickUrl(cfg: AxiosRequestConfig): string {
  const raw = urlOf(cfg);
  // Trim overlong query strings so the log stays readable.
  return raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
}

/**
 * Install once at process boot BEFORE any other module that makes HTTP calls
 * with axios. Safe to call multiple times — subsequent calls no-op.
 */
export function installHttpLogging(): void {
  if (installed) return;
  if (process.env.LOG_HTTP !== 'true') return;
  installed = true;

  axios.interceptors.request.use((cfg) => {
    (cfg as any).__startedAt = Date.now();
    log.debug(
      'http',
      `→ ${cfg.method?.toUpperCase() ?? 'GET'} ${pickUrl(cfg)}`,
      { headers: redactHeaders(cfg.headers) }
    );
    return cfg;
  });

  axios.interceptors.response.use(
    (res: AxiosResponse) => {
      const elapsed = Date.now() - ((res.config as any).__startedAt ?? Date.now());
      log.debug(
        'http',
        `← ${res.status} ${res.config.method?.toUpperCase() ?? 'GET'} ${pickUrl(
          res.config
        )} (${elapsed}ms)`
      );
      return res;
    },
    (err: AxiosError) => {
      const cfg = (err.config ?? {}) as AxiosRequestConfig;
      const elapsed = Date.now() - ((cfg as any).__startedAt ?? Date.now());
      const status = err.response?.status ?? '???';
      log.warn(
        'http',
        `✗ ${status} ${cfg.method?.toUpperCase() ?? 'GET'} ${pickUrl(cfg)} (${elapsed}ms)`,
        {
          body: err.response?.data,
          message: err.message,
        }
      );
      return Promise.reject(err);
    }
  );

  log.info('http', 'HTTP tracing enabled (LOG_HTTP=true)');
}
