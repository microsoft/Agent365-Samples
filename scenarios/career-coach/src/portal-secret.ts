// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * PORTAL_EVENT_SECRET is both the Graph subscription `clientState` and the `X-Portal-Secret` header
 * for manual tests, and /api/portal-event sits in front of the JWT check, so it must be a real secret.
 * An empty value, the shipped template placeholder, or a short guessable string is rejected.
 */
export function portalSecretProblem(secret: string | undefined = process.env.PORTAL_EVENT_SECRET): string | null {
    const value = (secret ?? '').trim();
    if (!value) return 'PORTAL_EVENT_SECRET is not set';
    if (/change_?me|^<.*>$/i.test(value)) return 'PORTAL_EVENT_SECRET still holds the template placeholder';
    if (value.length < 16) return 'PORTAL_EVENT_SECRET is too short (use at least 16 random characters)';
    return null;
}
