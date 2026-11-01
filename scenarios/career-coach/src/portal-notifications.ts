// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Chooses which LearningPortalStatus rows should become a proactive DM.
 *
 * Every Graph notification re-reads the whole sliding window, so without a checkpoint any activity
 * in the list would re-send other employees' cards. `handled` maps a user to the LastUpdated time
 * (ms) of the newest row already turned into a DM; a row is selected only if it is newer than that.
 */
export interface PortalChange {
    fields: Record<string, any>;
    updatedAt: number;
}

export function selectUsersToNotify(
    rows: Array<{ id: string; fields: Record<string, any> }>,
    cutoffMs: number,
    handled: Map<string, number>,
): Map<string, PortalChange> {
    const selected = new Map<string, PortalChange>();
    for (const row of rows) {
        const f = row.fields || {};
        const updatedAt = f.LastUpdated ? Date.parse(String(f.LastUpdated)) : NaN;
        if (!Number.isFinite(updatedAt) || updatedAt < cutoffMs) continue;
        const aad = String(f.UserAADId || '').trim();
        if (!aad) continue;
        const handledAt = handled.get(aad.toLowerCase());
        if (handledAt !== undefined && updatedAt <= handledAt) continue;
        // Keep the newest row per user (avoid a double DM when a user has several recent changes).
        const existing = selected.get(aad);
        if (!existing || existing.updatedAt < updatedAt) selected.set(aad, { fields: f, updatedAt });
    }
    return selected;
}
