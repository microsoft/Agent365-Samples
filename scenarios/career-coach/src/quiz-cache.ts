// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * In-memory quiz cache. When we render a quiz card, we cache the questions
 * (including correct answers + short-answer rubrics) server-side keyed by
 * userAADId + courseId. On submit, we look them up to grade deterministically.
 *
 * Kept in memory only — lost on server restart. If a user submits a quiz whose
 * cache entry is gone, we regenerate the questions on the fly (or ask them to
 * click the "retake" flow). Acceptable for a dev/demo setup.
 */

import { QuizQuestionWithKey } from './career-coach-service';

interface QuizCacheEntry {
    questions: QuizQuestionWithKey[];
    createdAt: number;
    attempts: number;
}

const cache = new Map<string, QuizCacheEntry>();

function keyOf(userAADId: string, courseId: string): string {
    return `${userAADId.toLowerCase()}::${courseId}`;
}

export function putQuiz(userAADId: string, courseId: string, questions: QuizQuestionWithKey[]): void {
    const key = keyOf(userAADId, courseId);
    const prior = cache.get(key);
    cache.set(key, {
        questions,
        createdAt: Date.now(),
        attempts: (prior?.attempts ?? 0),
    });
}

export function getQuiz(userAADId: string, courseId: string): QuizQuestionWithKey[] | null {
    const key = keyOf(userAADId, courseId);
    const entry = cache.get(key);
    return entry ? entry.questions : null;
}

export function bumpAttempts(userAADId: string, courseId: string): number {
    const key = keyOf(userAADId, courseId);
    const entry = cache.get(key);
    if (!entry) return 1;
    entry.attempts += 1;
    return entry.attempts;
}

export function clearQuiz(userAADId: string, courseId: string): void {
    cache.delete(keyOf(userAADId, courseId));
}
