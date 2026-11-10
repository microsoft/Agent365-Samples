// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as fs from 'fs';
import * as path from 'path';

export interface CompletionEmailReceipt {
    userAADId: string;
    itemId: string;
    userEmail: string;
    managerName?: string;
    managerEmail?: string;
    managerResolved: boolean;
    subject: string;
    totalMinutes: number;
    coursesCompleted: number;
    recordedAt: string;
}

const filePath = path.resolve(process.cwd(), '.completion-email-receipts.json');
const receipts = new Map<string, CompletionEmailReceipt>();
let loaded = false;

function keyOf(userAADId: string, itemId: string): string {
    return `${userAADId.toLowerCase()}::${itemId}`;
}

function isReceipt(value: unknown): value is CompletionEmailReceipt {
    if (!value || typeof value !== 'object') return false;
    const receipt = value as Partial<CompletionEmailReceipt>;
    return typeof receipt.userAADId === 'string'
        && typeof receipt.itemId === 'string'
        && typeof receipt.userEmail === 'string'
        && typeof receipt.managerResolved === 'boolean'
        && typeof receipt.subject === 'string'
        && typeof receipt.totalMinutes === 'number'
        && typeof receipt.coursesCompleted === 'number'
        && typeof receipt.recordedAt === 'string'
        && (receipt.managerName === undefined || typeof receipt.managerName === 'string')
        && (receipt.managerEmail === undefined || typeof receipt.managerEmail === 'string');
}

function ensureLoaded(): void {
    if (loaded) return;
    if (fs.existsSync(filePath)) {
        const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(`Invalid completion email receipt file: ${filePath}`);
        }
        for (const [key, value] of Object.entries(parsed)) {
            if (!isReceipt(value) || key !== keyOf(value.userAADId, value.itemId)) {
                throw new Error(`Invalid completion email receipt entry in ${filePath}`);
            }
            receipts.set(key, value);
        }
    }
    loaded = true;
}

function persist(): void {
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(Object.fromEntries(receipts)), 'utf-8');
    fs.renameSync(temporaryPath, filePath);
}

export function getCompletionEmailReceipt(userAADId: string, itemId: string): CompletionEmailReceipt | null {
    ensureLoaded();
    return receipts.get(keyOf(userAADId, itemId)) ?? null;
}

export function saveCompletionEmailReceipt(receipt: CompletionEmailReceipt): void {
    ensureLoaded();
    receipts.set(keyOf(receipt.userAADId, receipt.itemId), receipt);
    persist();
}

export function clearCompletionEmailReceipt(userAADId: string, itemId: string): void {
    ensureLoaded();
    if (receipts.delete(keyOf(userAADId, itemId))) persist();
}
