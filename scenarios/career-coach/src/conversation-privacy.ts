// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Privacy boundary for replies. Goals, skills, quiz results and progress are one employee's private
 * data, so they are only ever rendered into a conversation that is private to that employee.
 *
 * - Teams (`msteams`) always sets `conversationType`; only `personal` is private, so a group chat,
 *   channel or a missing / unknown type fails closed.
 * - Other channels (Agents Playground, Web Chat, test harnesses) don't always set a type; they are
 *   private unless the activity explicitly says it is a group conversation.
 *
 * `isPersonalConversation` in proactive-refs.ts is the stricter variant used for choosing where a
 * proactive message may be sent.
 */

export const PRIVATE_ONLY_NOTICE =
    'To keep your career information private, I only discuss goals, skills, quizzes and progress in a personal (1:1) chat. ' +
    'Please message me directly and we can continue there. 🔒';

export function isPrivateConversation(activity: { channelId?: string; conversation?: any } | undefined): boolean {
    if (!activity) return false;
    const conversation = activity.conversation;
    const type = String(conversation?.conversationType ?? '').toLowerCase();
    if (String(activity.channelId ?? '').toLowerCase() === 'msteams') return type === 'personal';
    if (conversation?.isGroup === true) return false;
    return type !== 'groupchat' && type !== 'channel';
}
