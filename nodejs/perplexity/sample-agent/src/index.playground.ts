// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// It is important to load environment variables before importing other modules
import { configDotenv } from "dotenv";

configDotenv();

import {
  AuthConfiguration,
  CloudAdapter,
  loadAuthConfigFromEnv,
  Request,
} from "@microsoft/agents-hosting";
import express, { Response } from "express";
import { app as agentApp } from "./agent";
import {
  Builder,
  ObservabilityManager,
} from "@microsoft/agents-a365-observability";

const a365Observability = ObservabilityManager.configure((builder: Builder) =>
  builder.withService("Perplexity Agent", "1.0.0")
);

const authConfig: AuthConfiguration = loadAuthConfigFromEnv();
const adapter = new CloudAdapter(authConfig);

const app = express();
app.use(express.json());

a365Observability.start();

app.post("/api/messages", async (req: Request, res: Response) => {
  await adapter.process(req, res, async (context) => {
    const app = agentApp;
    await app.run(context);
  });
});

const port = process.env["PORT"] || 3978;
const server = app
  .listen(port, () => {
    console.log(`\n🚀 Perplexity Agent listening on port ${port}`);
    console.log(`   App ID: ${authConfig.clientId}`);
    console.log(`   Debug: ${process.env["DEBUG"] || "false"}`);
    console.log(`\n✅ Agent ready to receive messages!`);
  })
  .on("error", async (err) => {
    console.error("Server error:", err);
    await a365Observability.shutdown();
    process.exit(1);
  })
  .on("close", async () => {
    console.log("A365 Observability is shutting down...");
    await a365Observability.shutdown();
  });

process.on("SIGINT", () => {
  console.log("Received SIGINT. Shutting down gracefully...");
  server.close(() => {
    console.log("Server closed.");
    process.exit(0);
  });
});
