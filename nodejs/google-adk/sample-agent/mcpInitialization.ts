// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export function validateDevelopmentToken(token: string | undefined): string {
  const value = token?.trim() ?? '';
  if (value && (process.env.NODE_ENV === 'production' || process.env.WEBSITE_SITE_NAME)) {
    console.error('Development bearer tokens are not permitted in production. Configure agentic authorization.');
    throw new Error('BEARER_TOKEN is only supported in local development.');
  }
  return value;
}

// Hosting token exchange has no AbortSignal API. Observe its settlement but stop
// awaiting it on cancellation, so it cannot resume initialization after the deadline.
export function withCancellation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      value => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
    if (signal.aborted) abort();
  });
}
