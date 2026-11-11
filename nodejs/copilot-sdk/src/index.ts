// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createClient, runCopilot, runtimeStatus } from './agent.js';
import { createTokenResolver } from './auth.js';
import { loadConfig, SDK_VERSION, RUNTIME_VERSION } from './config.js';
import { runOfflineSmoke } from './smoke.js';
import { createTelemetry } from './telemetry.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      smoke: { type: 'boolean' },
      'runtime-check': { type: 'boolean' },
      prompt: { type: 'string' },
    },
  });
  if ([values.smoke, values['runtime-check'], values.prompt !== undefined].filter(Boolean).length !== 1) {
    throw new Error('Choose exactly one: --smoke, --runtime-check, or --prompt "text"');
  }
  if (values['runtime-check']) {
    const client = createClient();
    try {
      console.log(JSON.stringify({ mode: 'runtime-check', sdkVersion: SDK_VERSION, ...await runtimeStatus(client) }));
    } finally {
      if ((await client.stop()).length) throw new Error('Runtime cleanup failed');
    }
    return;
  }
  // Smoke ignores ambient credentials/export flags; it never starts the runtime or makes network calls.
  const config = loadConfig(values.smoke ? {} : process.env);
  const tokenResolver = config.identity ? createTokenResolver(config.identity) : undefined;
  if (config.identity && tokenResolver) {
    await tokenResolver(config.identity.agentId, config.identity.tenantId);
  }
  const telemetry = createTelemetry(config, tokenResolver);
  try {
    if (values.smoke) {
      await runOfflineSmoke(telemetry);
      console.log('Offline smoke passed: deterministic success and expected tool failure; no live calls.');
    } else {
      if (!values.prompt?.trim()) throw new Error('Prompt must not be empty');
      console.log(await runCopilot(config, telemetry, values.prompt));
    }
  } finally {
    const evidence = {
      mode: values.smoke ? 'offline-synthetic-events' : 'live-copilot',
      sdkVersion: SDK_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      a365ExportRequested: config.exportToA365,
      a365IngestionVerified: false,
      spans: telemetry.snapshot(),
    };
    try {
      // Flush failure propagates; a successful callback is still not proof of sink ingestion.
      await telemetry.shutdown();
    } finally {
      console.log(JSON.stringify(evidence, null, 2));
      if (!values.smoke && process.env.COPILOT_TRACE_FILE) {
        await writeFile(process.env.COPILOT_TRACE_FILE, JSON.stringify(evidence, null, 2), { flag: 'wx' });
      }
    }
  }
}

main().catch((error: unknown) => {
  // Never dump upstream SDK/MSAL error objects, prompts, assertions, or credentials.
  const message = error instanceof Error ? error.message : '';
  const safe = /^(Choose exactly|Prompt must|AGENT365_|ENABLE_A365_|Live export requires|COPILOT_TIMEOUT_MS|Unset COPILOT_CLI_PATH|A365 S2S authentication failed|Copilot is not authenticated|Runtime version does not match)/.test(message);
  console.error(safe ? message : 'Sample failed (runtime, tool, configuration, or export). No live ingestion is claimed.');
  process.exitCode = 1;
});
