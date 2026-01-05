// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { config } from "dotenv";

config();

import { startServer } from "@microsoft/agents-hosting-express";
import { ObservabilityManager } from "@microsoft/agents-a365-observability";
import { app } from "./agent.js";

import { presenceKeepAlive } from "./presence-runtime.js";
import { discoverAgentUserIdsForBlueprint } from "./agent-registry-bootstrap.js";

presenceKeepAlive.start();

/**
 * Bootstraps the agent user presence from the registry.
 * @returns A promise that resolves when the bootstrap process is complete.
 */
async function bootstrapFromRegistry() {
  const tenantId =
    process.env["connections__serviceConnection__settings__tenantId"];
  const agentIdentityBlueprintId =
    process.env["connections__serviceConnection__settings__clientId"];
  const clientId = process.env["PRESENCE_CLIENTID"];
  const clientSecret = process.env["PRESENCE_CLIENTSECRET"];
  const presenceSessionId = process.env["PRESENCE_CLIENTID"];

  if (
    !tenantId ||
    !agentIdentityBlueprintId ||
    !clientId ||
    !clientSecret ||
    !presenceSessionId
  ) {
    console.warn(
      "⚠️ AgentRegistry bootstrap skipped (missing one of: tenantId, AGENT_IDENTITY_BLUEPRINT_ID, clientId/secret, PRESENCE_CLIENTID)"
    );
    return;
  }

  const agentUserIds = await discoverAgentUserIdsForBlueprint({
    tenantId,
    clientId,
    clientSecret,
    blueprintAppId: agentIdentityBlueprintId,
  });

  for (const userId of agentUserIds) {
    presenceKeepAlive.register({
      userId,
    });
  }

  console.log("✅ Bootstrapped agent users:", agentUserIds.length);
}

// bootstrap once on start (best-effort)
bootstrapFromRegistry().catch((e) =>
  console.error("❌ bootstrapFromRegistry failed:", e?.message ?? e)
);

// resync periodically to catch newly created instances
const resyncTimer = setInterval(() => {
  bootstrapFromRegistry().catch((e) =>
    console.error("❌ periodic bootstrap failed:", e?.message ?? e)
  );
}, 10 * 60 * 1000);

console.log("🚀 Starting Perplexity Agent");
console.log("   Activity Protocol Mode with Observability\n");

try {
  startServer(app);
  console.log("✅ Agent server is running and ready to accept connections");
  console.log(
    "🔭 Observability SDK is active and tracking agent interactions\n"
  );
} catch (err) {
  console.error("Failed to start server:", err);
  process.exit(1);
}

async function shutdown(code: number) {
  console.log("\n🛑 Shutting down agent...");
  clearInterval(resyncTimer);
  presenceKeepAlive.stop();

  try {
    await ObservabilityManager.shutdown();
    console.log("🔭 Observability SDK shut down gracefully");
    process.exit(code);
  } catch (err) {
    console.error("Error during shutdown:", err);
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
