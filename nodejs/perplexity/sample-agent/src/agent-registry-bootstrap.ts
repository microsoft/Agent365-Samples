// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Client } from "@microsoft/microsoft-graph-client";
import { ClientSecretCredential } from "@azure/identity";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js";

type AgentIdentity = {
  id: string;
  displayName?: string;
  agentIdentityBlueprintId?: string;
};

type AgentUser = {
  id: string;
  displayName?: string;
  identityParentId?: string;
};

/**
 * Gets a Microsoft Graph client for the specified tenant using
 * the provided app registration credentials.
 * @param tenantId The id of the tenant
 * @param clientId The client id of the app registration
 * @param clientSecret The client secret of the app registration
 * @returns A Microsoft Graph client instance
 */
function getGraphClient(
  tenantId: string,
  clientId: string,
  clientSecret: string
): Client {
  const cred = new ClientSecretCredential(tenantId, clientId, clientSecret);
  const authProvider = new TokenCredentialAuthenticationProvider(cred, {
    scopes: ["https://graph.microsoft.com/.default"],
  });
  return Client.initWithMiddleware({ authProvider });
}

/**
 * The function to perform paged GET requests against Microsoft Graph.
 * @param client the Graph client for the target tenant
 * @param path the initial API path to GET
 * @returns A promise that resolves to an array of results of type T
 */
async function pagedGet<T>(client: Client, path: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = path;

  while (next) {
    const res = await client
      .api(next)
      .version("beta")
      .header("ConsistencyLevel", "eventual")
      .get();

    out.push(...((res?.value ?? []) as T[]));
    next = res?.["@odata.nextLink"];
  }

  return out;
}

/**
 * The function determines whether the given error indicates that
 * the OData filter on agentIdentityBlueprintId is unsupported.
 * @param e Error object
 * @returns True if the error indicates an unsupported filter, false otherwise
 */
function isUnsupportedFilter(e: any): boolean {
  const msg = String(e?.message ?? "");
  return (
    e?.statusCode === 400 &&
    msg.includes("Unsupported or invalid query filter clause") &&
    msg.includes("agentIdentityBlueprintId")
  );
}

/**
 * Gets the agent identities associated with the specified blueprint application.
 * @param graph the Graph client for the target tenant
 * @param blueprintAppId the blueprint application (client) ID
 * @returns A promise that resolves to an array of AgentIdentity objects
 */
async function getAgentIdentitiesForBlueprint(
  graph: any,
  blueprintAppId: string
): Promise<AgentIdentity[]> {
  const base =
    `/servicePrincipals/microsoft.graph.agentIdentity` +
    `?$select=id,displayName,agentIdentityBlueprintId&$top=999`;

  // Try a few OData literal forms (Graph can be picky here depending on type/backing)
  const candidates = [
    `${base}&$count=true&$filter=agentIdentityBlueprintId eq '${blueprintAppId}'`,
    `${base}&$count=true&$filter=agentIdentityBlueprintId eq ${blueprintAppId}`, // no quotes
    `${base}&$count=true&$filter=agentIdentityBlueprintId eq guid'${blueprintAppId}'`, // guid literal
  ];

  for (const path of candidates) {
    try {
      return await pagedGet<AgentIdentity>(graph, path);
    } catch (e: any) {
      if (!isUnsupportedFilter(e)) throw e;
    }
  }

  // Final fallback: no server-side filter; filter locally
  const all = await pagedGet<AgentIdentity>(graph, base);
  return all.filter(
    (i) =>
      (i.agentIdentityBlueprintId ?? "").toLowerCase() ===
      blueprintAppId.toLowerCase()
  );
}

/**
 * Gets the user IDs of agent users associated with the specified blueprint application.
 * @param args The arguments containing tenant and blueprint information
 * @returns a Promise that resolves to an array of user IDs
 */
export async function discoverAgentUserIdsForBlueprint(args: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  blueprintAppId: string;
}): Promise<string[]> {
  const graph = getGraphClient(args.tenantId, args.clientId, args.clientSecret);

  const identities = await getAgentIdentitiesForBlueprint(
    graph,
    args.blueprintAppId
  );

  const userIds = new Set<string>();

  for (const identity of identities) {
    const users = await pagedGet<AgentUser>(
      graph,
      `/users/microsoft.graph.agentUser` +
        `?$select=id,displayName,identityParentId&$count=true` +
        `&$filter=identityParentId eq '${identity.id}'`
    );

    for (const u of users) {
      userIds.add(u.id);
    }
  }

  return [...userIds];
}
