// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Command router: parses the user's message for `/…` slash commands and routes
 * to the appropriate handler.
 *
 * Returns `true` if a command was recognized and handled (so the caller should
 * skip the default LLM message flow), `false` otherwise.
 */

import { TurnContext } from '@microsoft/agents-hosting';

import { triggerStandup } from './standup';
import { handleConfigChannel } from './config';

const HELP_TEXT = [
    'Available commands:',
    '`/standup` — kick off today\'s standup for the active sprint',
    '`/config channel` — (run from a Teams channel) set the channel I post summaries to',
    '`/help` — show this message',
].join('\n');

export async function tryHandleCommand(context: TurnContext): Promise<boolean> {
    const text = (context.activity.text ?? '').trim();
    if (!text.startsWith('/')) return false;

    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const args = rest.join(' ');
    const from = context.activity.from;
    console.log(`[commands] '${cmd}' args='${args}' from=${from?.name}(${from?.aadObjectId})`);

    switch (cmd.toLowerCase()) {
        case 'standup':
            await triggerStandup({
                initiatedByAadId: from?.aadObjectId ?? undefined,
                turnContext: context,
                source: 'command',
            });
            return true;

        case 'config':
            if (args.trim().toLowerCase().startsWith('channel')) {
                await handleConfigChannel(context);
                return true;
            }
            await context.sendActivity(`Unknown config target. Try \`/config channel\`.`);
            return true;

        case 'help':
            await context.sendActivity(HELP_TEXT);
            return true;

        default:
            // Not a command we recognize — fall through to LLM flow.
            return false;
    }
}
