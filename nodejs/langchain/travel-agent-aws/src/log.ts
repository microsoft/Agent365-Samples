// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Production logs carry metadata only. LangChain, MCP, Graph and Bedrock errors often embed prompt
// text, tool output or response bodies in message/stack/cause, so outside verbose mode an error is
// reduced to its name plus a numeric status or short code. Set DEBUG=1 for full local logs.
export function isVerbose(): boolean {
  return process.env.NODE_ENV !== 'production' || !!process.env.DEBUG;
}

export function debug(...args: unknown[]): void {
  if (isVerbose()) console.log(...args);
}

const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

function summarize(err: unknown): string {
  const e: any = err;
  const name = typeof e?.name === 'string' && SAFE_CODE.test(e.name) ? e.name : 'Error';
  const parts = [name];
  const status = e?.status ?? e?.statusCode ?? e?.$metadata?.httpStatusCode;
  if (typeof status === 'number') parts.push(`status=${status}`);
  if ((typeof e?.code === 'string' && SAFE_CODE.test(e.code)) || typeof e?.code === 'number') {
    parts.push(`code=${e.code}`);
  }
  return parts.join(' ');
}

// Name/status/code of an error and of its direct cause, never message, stack or payload.
export function errorSummary(err: unknown): string {
  const cause = (err as any)?.cause;
  return cause ? `${summarize(err)} (cause: ${summarize(cause)})` : summarize(err);
}

export function logError(tag: string, err: unknown): void {
  if (isVerbose()) {
    console.error(tag, err);
  } else {
    console.error(`${tag} ${errorSummary(err)}`);
  }
}

// Same policy as logError, at warning level, for failures the turn recovers from.
export function logWarn(tag: string, err: unknown): void {
  if (isVerbose()) {
    console.warn(tag, err);
  } else {
    console.warn(`${tag} ${errorSummary(err)}`);
  }
}
