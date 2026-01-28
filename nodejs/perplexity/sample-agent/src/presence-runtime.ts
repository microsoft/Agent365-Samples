// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { PresenceKeepAliveManager } from "./presence-keepalive";

// Use PRESENCE_CLIENTID as the sessionId - this is the Application (client) ID
const presenceSessionId = process.env["PRESENCE_CLIENTID"] || "";
const tenantId =
  process.env["connections__serviceConnection__settings__tenantId"] || "";

export const presenceKeepAlive = new PresenceKeepAliveManager(
  presenceSessionId,
  tenantId
);
