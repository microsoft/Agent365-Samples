// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// It is important to load environment variables before importing other modules
import { configDotenv } from "dotenv";

configDotenv();

import {
  AuthConfiguration,
  authorizeJWT,
  CloudAdapter,
  loadAuthConfigFromEnv,
  Request,
} from "@microsoft/agents-hosting";
import express, { Response } from "express";
import { app as agentApplication } from "./agent";

import { presenceKeepAlive } from "./presence-runtime";
import { discoverAgentUserIdsForBlueprint } from "./agent-registry-bootstrap";

presenceKeepAlive.start();

// Use request validation middleware only if hosting publicly
const isProduction = process.env["NODE_ENV"] === "production";
const authConfig: AuthConfiguration = isProduction
  ? loadAuthConfigFromEnv()
  : {};

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
      "⚠️ AgentRegistry bootstrap skipped (missing one of: tenantId, AGENT_IDENTITY_BLUEPRINT_ID, clientId/secret, PRESENCE_CLIENTID)",
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
  console.error("❌ bootstrapFromRegistry failed:", e?.message ?? e),
);

// resync periodically to catch newly created instances
const resyncTimer = setInterval(
  () => {
    bootstrapFromRegistry().catch((e) =>
      console.error("❌ periodic bootstrap failed:", e?.message ?? e),
    );
  },
  10 * 60 * 1000,
);

console.log("🚀 Starting Perplexity Agent");
console.log("   Activity Protocol Mode with Observability\n");

const server = express();
server.use(express.json());

// Health endpoint - placed BEFORE auth middleware so it doesn't require authentication
server.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

server.use(authorizeJWT(authConfig));

server.post("/api/messages", (req: Request, res: Response) => {
  const adapter = agentApplication.adapter as CloudAdapter;
  adapter.process(req, res, async (context) => {
    await agentApplication.run(context);
  });
});

const port = Number(process.env["PORT"]) || 3978;
const host = isProduction ? "0.0.0.0" : "127.0.0.1";
server
  .listen(port, host, async () => {
    console.log(
      `\nServer listening on ${host}:${port} for appId ${authConfig.clientId || process.env["connections__serviceConnection__settings__clientId"]} debug ${process.env["DEBUG"]}`,
    );
  })
  .on("error", async (err: unknown) => {
    console.error(err);
    process.exit(1);
  })
  .on("close", async () => {
    console.log("Server closed - cleaning up timers");
    clearInterval(resyncTimer);
    presenceKeepAlive.stop();
    process.exit(0);
  });
