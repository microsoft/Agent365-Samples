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
import { app as agentApp } from "./agent";

// Use request validation middleware only if hosting publicly
const isProduction =
  Boolean(process.env["WEBSITE_SITE_NAME"]) ||
  process.env["NODE_ENV"] === "production";
const authConfig: AuthConfiguration = isProduction
  ? loadAuthConfigFromEnv()
  : {};

const server = express();
server.use(express.json());
server.use(authorizeJWT(authConfig));

server.post("/api/messages", (req: Request, res: Response) => {
  const adapter = agentApp.adapter as CloudAdapter;
  adapter.process(req, res, async (context) => {
    await agentApp.run(context);
  });
});

const port = Number(process.env["PORT"]) || 3978;
const host = isProduction ? "0.0.0.0" : "127.0.0.1";
server
  .listen(port, host, async () => {
    console.log(
      `\n🚀 Perplexity Agent listening on ${host}:${port} for appId ${
        authConfig.clientId || "(local dev)"
      } debug ${process.env["DEBUG"]}`
    );
    console.log("✅ Agent ready to receive messages!");
    console.log("   Test with: npm run test-tool");
  })
  .on("error", async (err: unknown) => {
    console.error("Server error:", err);
    process.exit(1);
  })
  .on("close", async () => {
    console.log("Server closed");
    process.exit(0);
  });
