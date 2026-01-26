// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// It is important to load environment variables before importing other modules
import { configDotenv } from "dotenv";

configDotenv();

import {
  AuthConfiguration,
  authorizeJWT,
  CloudAdapter,
  Request,
} from "@microsoft/agents-hosting";
import { startServer } from "@microsoft/agents-hosting-express";
import { ObservabilityManager } from "@microsoft/agents-a365-observability";
import express, { Response } from "express";
import { app as agentApp } from "./agent";

// Use request validation middleware only if hosting publicly
const isProduction = process.env["NODE_ENV"] === "production";

if (isProduction) {
  /**
   * Production Mode: Using startServer helper for Azure deployment
   */
  console.log("🚀 Starting Perplexity Agent (Production Mode)");
  console.log("   Activity Protocol Mode with Observability");
  console.log("");

  // Add health endpoint
  agentApp.get("/health", (req, res) => {
    res.status(200).json({
      status: "healthy",
      timestamp: new Date().toISOString(),
    });
  });

  try {
    startServer(agentApp);
    console.log("✅ Agent server is running and ready to accept connections");
    console.log(
      "🔭 Observability SDK is active and tracking agent interactions",
    );
    console.log("");
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }

  /**
   * Graceful shutdown handling for observability
   */
  process.on("SIGINT", async () => {
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

  process.on("SIGTERM", async () => {
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
} else {
  /**
   * Development Mode: Manual Express setup for playground testing
   */
  console.log("🚀 Starting Perplexity Agent (Development Mode)");

  const authConfig: AuthConfiguration = {};
  const adapter = new CloudAdapter(authConfig);

  const server = express();
  server.use(express.json());
  server.use(authorizeJWT(authConfig));

  server.post("/api/messages", (req: Request, res: Response) => {
    adapter.process(req, res, async (context) => {
      await agentApp.run(context);
    });
  });

  // Add health endpoint
  server.get("/health", (req, res) => {
    res.status(200).json({
      status: "healthy",
      timestamp: new Date().toISOString(),
    });
  });

  const port = Number(process.env["PORT"]) || 3978;
  const host = "127.0.0.1";
  const httpServer = server
    .listen(port, host, async () => {
      console.log(
        `\n🚀 Perplexity Agent listening on ${host}:${port} (local dev)`,
      );
      console.log("✅ Agent ready to receive messages!");
      console.log("   Test with: npm run test-tool");
    })
    .on("error", async (err: unknown) => {
      console.error("Server error:", err);
      await ObservabilityManager.shutdown();
      process.exit(1);
    })
    .on("close", async () => {
      console.log("Server closed");
      await ObservabilityManager.shutdown();
      process.exit(0);
    });

  /**
   * Graceful shutdown handling for development mode
   */
  process.on("SIGINT", () => {
    console.log("Received SIGINT. Shutting down gracefully...");
    httpServer.close(() => {
      console.log("Server closed.");
      process.exit(0);
    });
  });

  process.on("SIGTERM", async () => {
    console.log("\n🛑 Shutting down agent...");
    try {
      httpServer.close();
      await ObservabilityManager.shutdown();
      console.log("🔭 Observability SDK shut down gracefully");
      process.exit(0);
    } catch (err) {
      console.error("Error during shutdown:", err);
      process.exit(1);
    }
  });
}
