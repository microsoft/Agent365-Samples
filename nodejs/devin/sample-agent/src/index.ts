// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ObservabilityManager } from "@microsoft/agents-a365-observability";
import {
  AuthConfiguration,
  authorizeJWT,
  CloudAdapter,
  loadAuthConfigFromEnv,
  Request,
} from "@microsoft/agents-hosting";
import express, { Response } from "express";
import { agentApplication } from "./agent";

const authConfig: AuthConfiguration = loadAuthConfigFromEnv();
const adapter = new CloudAdapter(authConfig);

const app = express();
app.use(express.json());
app.use(authorizeJWT(authConfig));

app.post("/api/messages", async (req: Request, res: Response) => {
  await adapter.process(req, res, async (context) => {
    const app = agentApplication;
    await app.run(context);
  });
});

const port = process.env.PORT || 3978;
const server = app
  .listen(port, () => {
    console.log(
      `\nServer listening to port ${port} for appId ${authConfig.clientId} debug ${process.env.DEBUG}`
    );
  })
  .on("error", async (err) => {
    console.error(err);
    process.exit(1);
  })
  .on("close", async () => {
    console.log("Server is shutting down...");
  });

process
  .on("SIGINT", async () => {
    console.log("\n🛑 Shutting down agent...");
    try {
      server.close();
      await ObservabilityManager.shutdown();
      console.log("🔭 Observability SDK shut down gracefully");
      process.exit(0);
    } catch (err) {
      console.error("Error during shutdown:", err);
      process.exit(1);
    }
  })
  .on("SIGTERM", async () => {
    console.log("\n🛑 Shutting down agent...");
    try {
      await ObservabilityManager.shutdown();
      console.log("🔭 Observability SDK shut down gracefully");
      process.exit(0);
    } catch (err) {
      console.error("Error during shutdown:", err);
      process.exit(1);
    }
  });
