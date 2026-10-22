# Travel Agent on AWS - LangChain (Node.js)

An AI Teammate built with **LangChain** on the **Microsoft Agent 365 SDK**. Give it a
destination and travel dates and it plans the trip — flights, hotels, and restaurants —
writes an **editable Word document** to OneDrive, shares it with you (edit access) when your work
account can be verified, and can reply to **@mentions on Word comments**.

The messaging endpoint runs on **AWS Lambda Web Functions** and calls **Amazon Bedrock**
using an execution role, without model API keys. Microsoft 365 continues to provide the
agent identity, Teams integration, and Word/OneDrive tools.

> The flight, hotel, and restaurant tools generate **synthetic demonstration data**.
> They do not query live inventory, make reservations, or process payments.

## Demonstrates

- **AWS hosting and models** - a managed HTTPS messaging endpoint with IAM-authenticated Bedrock inference
- **Travel tools** — flight, hotel, and restaurant search wired as LangChain tools
- **WorkIQ MCP tools** — create / read / edit Word documents and manage OneDrive files via
  the `mcp_WordServer` and `mcp_OneDriveRemoteServer` Model Context Protocol servers
- **Notifications** — Word `@mention` comment replies and proactive Teams DMs
- **Observability wiring** - A365 OpenTelemetry scopes and hosting integration; cloud export
  is optional and disabled in the supplied environment template and CloudFormation deployment
- **Hosting patterns** — Express + `CloudAdapter` hosting with the Microsoft 365 Agents SDK

This sample uses the [Microsoft Agent 365 SDK for Node.js](https://github.com/microsoft/Agent365-nodejs).
For comprehensive guidance on building agents — tooling, observability, and notifications —
see the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## What the agent does

- **Plans trips** — "Plan a 3-day trip to San Francisco on July 9 departing from Seattle"
  → searches 3 flights, 3 hotels, and breakfast/lunch/dinner restaurant picks.
- **Creates editable documents** — writes the itinerary to a `.docx` in the agent's OneDrive
  and grants **edit** access to the verified requesting user only. If the requester can't be
  verified, or the grant fails, the agent says so instead of creating a broader link.
- **Replies to Word comments** — when you `@mention` the agent on a comment in a shared Word
  doc, it reads the document and posts a reply on that comment, then DMs you the reply in Teams.
- **Remembers context** — per-conversation memory resolves follow-ups like "cheaper ones" or
  "change the dates to July" without re-asking.

## Prerequisites

> To run this agent you will need:
>
> - [Git](https://git-scm.com/), [Node.js](https://nodejs.org/) 24 or higher, and npm
> - PowerShell 7 (`pwsh`); the Agent 365 CLI requires it for Microsoft Graph sign-in. The deployment
>   scripts also run in Windows PowerShell 5.1
> - [.NET 8 SDK](https://dotnet.microsoft.com/download) or later, used to install the Agent 365 CLI
> - An AWS account with access to **Amazon Bedrock** in the deployment Region
> - [Microsoft 365 Agents Toolkit](https://aka.ms/teams-toolkit) (for Agents Playground) or the
>   `agentsplayground` CLI
> - [Azure CLI](https://learn.microsoft.com/cli/azure/) for Microsoft 365 tenant sign-in; no Azure
>   subscription or Azure OpenAI deployment is needed for the AWS path
> - [AWS CLI v2](https://aws.amazon.com/cli/) 2.38+ with the `lambda-web` commands
> - [Agent 365 CLI](https://github.com/microsoft/Agent365-devTools) (`a365`) — for registration,
>   WorkIQ tools, and publishing the agent manifest. Install it with
>   `dotnet tool install --global Microsoft.Agents.A365.DevTools.Cli --prerelease`
> - An Agent 365-enabled Microsoft 365 tenant, with permission to register a blueprint and
>   an administrator available for required consent and agent approval
>
> For a browser-only deployment, your administrator prepares a release link and blueprint values;
> follow [the browser deployment guide](aws/DEPLOY-GUIDE.md) instead.

## How to run this sample

1. Clone the repository and open this sample's folder:

   ```powershell
   git clone https://github.com/microsoft/Agent365-Samples.git
   cd Agent365-Samples\nodejs\langchain\travel-agent-aws
   ```

2. Create your local configuration and register a **new** Agent 365 blueprint:

   ```powershell
   Copy-Item .env.example .env
   az login --allow-no-subscriptions --tenant YOUR_MICROSOFT_365_TENANT_ID
   a365 setup all --agent-name "Travel Agent AWS" --aiteammate --m365
   ```

   Replace `YOUR_MICROSOFT_365_TENANT_ID` with your tenant ID before running the command.
   When setup asks for **Messaging endpoint URL**, leave it blank and press Enter.
   Complete the sign-in/consent prompts. Setup creates local `a365.config.json`,
   `a365.generated.config.json`, and fills the blueprint connection values in `.env`.
   Keep `ToolingManifest.json` in this folder so setup registers Word and OneDrive tools.

3. Sign in to AWS, confirm the target account, and deploy:

   ```powershell
   aws configure set region us-east-2
   aws login
   aws sts get-caller-identity
   .\deploy-aws.ps1 -FunctionName travelagentdw -Region us-east-2 -UpdateA365Endpoint
   ```

   Confirm that the `Account` in the identity output is the AWS account you intend to use.
   The sample's display name is **Travel Agent AWS**; its AWS resources (Web Function, IAM role
   `travelagentdw-exec`, log groups, Secrets Manager secret, CloudFormation stack) use the short name
   `travelagentdw`, which you can change with `-FunctionName`.
   The script builds the app, deploys it, checks health (HTTP 200) and authentication
   (unauthenticated messages return HTTP 401), and registers the printed **Messaging endpoint**
   with the blueprint. Client secrets from `.env` go to AWS Secrets Manager, not to the function's
   environment (see [Secrets on AWS](#secrets-on-aws)). If your setup tool changes `.env` afterward,
   send the final settings with
   `.\deploy-aws.ps1 -FunctionName travelagentdw -Region us-east-2 -SettingsOnly`. If the function was
   deployed by an earlier version of this sample (before Secrets Manager support), run one full deploy
   first; `-SettingsOnly` stops with an error rather than moving secrets away from code that can't read them.

4. Package and connect the agent to Teams:

   ```powershell
   a365 publish
   ```

   This generates `manifest\manifest.zip`; it does not upload the agent.
   Upload that package in Microsoft 365 admin center under **Agents > All agents > Upload custom
   agent**. Verify the Teams Developer Portal notification URL matches the printed `/api/messages`
   URL. Request an instance in Teams and have your tenant administrator approve it.
   See [the admin connection steps](aws/DEPLOY-GUIDE.md#when-the-person-sends-back-their-messagingendpoint)
   for the handoff.

5. Chat with the agent in Teams. For example:
   "Plan a three-day trip from Seattle to San Francisco next month. Create an editable Word
   itinerary and share its link with me." Open the returned document and test an `@mention` comment.

## Configuration

The checked-in [.env.example](.env.example) contains no credentials. `.env` and all generated
tenant/blueprint configuration stay local and are ignored by Git.

Settings are listed in the order they appear in `.env.example`.

| Variable | Description |
|---|---|
| `NODE_ENV` | `development` for local runs (console exporters on, listens on `127.0.0.1`). `deploy-aws.ps1` and the CloudFormation template always set `production` on AWS |
| `LLM_PROVIDER` | `bedrock` = Amazon Bedrock, the default for this sample and forced by `deploy-aws.ps1`. `openai` skips the Azure OpenAI block. Leave it empty to use Azure OpenAI, then OpenAI, then Bedrock (if `BEDROCK_MODEL_ID` is set) |
| `BEDROCK_MODEL_ID` | Bedrock model or inference profile id (e.g. `us.amazon.nova-2-lite-v1:0`, `us.anthropic.claude-sonnet-4-6`) |
| `BEDROCK_REGION` / `BEDROCK_MAX_TOKENS` | Bedrock Region (default `AWS_REGION`, then `us-east-1`) / max output tokens including model reasoning (default 8192) |
| `agent_id` | Written by `a365 setup`; the app does not read it |
| `connections__service_connection__settings__clientId` / `clientSecret` / `tenantId` | Blueprint connection used to authenticate `/api/messages` and acquire agentic tokens; setup populates these. On AWS the client secret is stored in Secrets Manager, not in an environment variable |
| `connections__service_connection__settings__scopes` | Token scope for the blueprint connection (default in `.env.example`; don't change it) |
| `connectionsMap__0__serviceUrl` / `connectionsMap__0__connection` | Route every incoming service URL (`*`) to `service_connection` |
| `agentic_altBlueprintConnectionName` / `agentic_connectionName` / `agentic_scopes` | Agentic user authentication handler for Teams and WorkIQ (written by `a365 setup all`) |
| `ENABLE_A365_OBSERVABILITY_EXPORTER` | `false` by default. When `true`, spans export over the S2S endpoint with an app-only token and the four `AGENT365_OBS_*` settings below are required (startup fails if any is missing or a placeholder) |
| `AGENT365_OBS_TENANT_ID` / `AGENT365_OBS_AGENT_ID` | Tenant and agent **instance** client id that export is allowed for; must match the activity's `recipient.tenantId` / `recipient.agenticAppId` |
| `AGENT365_OBS_BLUEPRINT_CLIENT_ID` / `AGENT365_OBS_BLUEPRINT_CLIENT_SECRET` | Blueprint credential used only to acquire the app-only OBS token (FMI chain). On AWS the secret is stored in Secrets Manager, not in an environment variable |
| `agent365Observability__agentId` | Optional local fallback for the span agent id when an activity has no `recipient.agenticAppId`. Use the agent **instance** id; a value equal to the blueprint id is ignored, so spans are never attributed to the blueprint |
| `agent365Observability__agentBlueprintId` | Blueprint id stamped on spans |
| `agent365Observability__tenantId` | Tenant id used on spans when the activity lacks `recipient.tenantId` |
| `agent365Observability__agentName` / `agent365Observability__agentDescription` | Agent name (also the OpenTelemetry `service.name`) and description on spans |
| `SHARE_SEND_INVITATION` | `true` by default; set `false` to grant edit access to created documents without the OneDrive invitation email |
| `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_DEPLOYMENT` / `AZURE_OPENAI_API_VERSION` | Optional alternative for local testing (e.g. endpoint `https://<resource>.openai.azure.com/`, version `2024-12-01-preview`). `deploy-aws.ps1` never ships these |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | Optional alternative for local testing, used when the Azure OpenAI block is incomplete or `LLM_PROVIDER=openai`. `deploy-aws.ps1` never ships these |
| `A365_SECRETS_ARN` | Set only on AWS, by `deploy-aws.ps1` or the CloudFormation stack: the ARN of the Secrets Manager secret whose JSON holds the client secrets, read once at cold start. Not in `.env.example`; leave it unset locally |

> `a365 setup all --aiteammate --m365` populates most of the A365 keys automatically.
> To use Amazon Bedrock locally, keep `LLM_PROVIDER=bedrock` and set `BEDROCK_MODEL_ID`; the AWS SDK
> picks up your AWS CLI sign-in (`aws login`, SSO profile, or `AWS_PROFILE`).

### Secrets on AWS

`deploy-aws.ps1` never passes secret values as AWS CLI arguments or function environment variables.
It moves every secret setting in `.env` (the blueprint client secret, `AGENT365_OBS_BLUEPRINT_CLIENT_SECRET`,
and any `*_SECRET`, `*ClientSecret`, `*_KEY`, `*PASSWORD` or `*TOKEN*` key, except token counts such as
`BEDROCK_MAX_TOKENS` and names ending in `_URL` or `ENDPOINT`) into one AWS Secrets Manager
secret, `<FunctionName>/agent365` (`travelagentdw/agent365` by default). The secret's value is a JSON
object of setting names to values, uploaded from a temporary file that only you can read and that is
deleted afterwards. The function receives only `A365_SECRETS_ARN`; at cold start
[src/lambda.ts](src/lambda.ts) loads `secrets.ts`, which reads the secret through the execution role's
`secrets-read` policy (`secretsmanager:GetSecretValue` on that one secret) and fills in settings that
aren't already set. If the secret can't be read, startup fails with a short error that names no values.
`-SettingsOnly` refreshes the secret and the policy too, but the first deploy after upgrading from a
version without Secrets Manager support must be a full deploy. The CloudFormation stack does the same with a
stack-owned secret. Local runs don't use Secrets Manager; they read `.env`.

## Running the agent

### Microsoft 365 Agents Playground

```bash
npm run test-tool
```

Start the local agent first as described below, then launch `agentsplayground` in a second
terminal. Configure the Playground's agentic identity and authentication following
[Configure Agent Testing](https://learn.microsoft.com/microsoft-agent-365/developer/testing?tabs=nodejs);
the production Teams connection is not an anonymous Playground configuration.

### Locally

```bash
npm install     # installs dependencies and compiles TypeScript through postinstall
npm start       # node dist/index.js  (listens on http://127.0.0.1:3978)
```

The app has no unauthenticated test route: only `GET /api/health` is open, and `POST /api/messages`
requires a valid Agent 365 token. Send local test turns through Agents Playground.

For live-reload development:

```bash
npm run dev   # tsx watch (ESM TypeScript, auto-restart, Node inspector on 9239)
```

Unit tests (pure helpers such as tool-result parsing and the MCP tool policy; no credentials or AWS
access needed):

```bash
npm test
```

## Key features

### Travel planning tools

Three LangChain tools ([src/tools/](src/tools/)) back the planning flow — `SearchFlights`,
`SearchHotels`, and `SearchRestaurants` — orchestrated by the system prompt in
[src/client.ts](src/client.ts).

### Editable Word documents + sharing

When you ask for a Word document, the model creates the `.docx` with `mcp_WordServer`
`CreateDocument` in the **agent's** OneDrive. After the turn, the code (not the model) reads only
this turn's tool results for created files — each MCP text block separately, since MCP-Platform
appends a `CorrelationId` block to every result — and grants **you** write access by calling
`mcp_OneDriveRemoteServer` `shareFileOrFolderInMyOnedrive` with `roles: ["write"]`. The reply ends
with the document link and the real outcome — or an explicit failure message (including when a
document was created but could not be identified or shared). Documents are recorded the moment the
create tool succeeds, so if the turn fails afterwards (for example, a later model call errors), the
agent still shares the document with you and reports it alongside the error.

- **Who it is shared with** — only the verified requester. Your UPN comes from the authenticated
  agents channel or from the Teams roster entry whose AAD object id matches yours; it is never
  inferred from a display name. If it can't be verified, the document is not shared and the agent
  tells you so.
- **No broader fallback** — the agent never creates organization-wide or anonymous links, and it
  does not broaden access when a grant fails. To give other people access, open the document (you
  have edit access) and use **Share**.
- **Code-enforced tool policy** — the agent's OneDrive holds documents for **everyone** who uses this
  agent instance, so the model only receives `CreateDocument` (with its `shareWith` parameter
  removed), `GetDocumentContent`, `ReplyToComment`, `AddComment`, and `createSmallTextFileInMyOnedrive`
  ([src/mcp-tool-policy.ts](src/mcp-tool-policy.ts)). OneDrive list, search, read, move, rename,
  delete and share tools are withheld from the model; the share tool is called only by code, for an
  item created in the current turn.
- **Document access guard** — the agent's account can open every document in its OneDrive, so code
  also checks each `GetDocumentContent`, `AddComment` and `ReplyToComment` call
  (`src/document-access.ts`). They work only on documents the agent created for **you** (remembered
  for 24 hours, in memory) or on the document from the Word comment notification being handled. On a
  notification turn only the notified document is reachable: your other documents can't be read,
  `AddComment` is refused, and `ReplyToComment` must target a notified comment on the drive and item
  that reading the notified document returned. Anything else, such as a pasted link to another person's
  document, is refused with "Access denied"; the log records only the tool name and the decision.
- **Requirements** — the OneDrive share tool accepts email/UPN recipients only (not AAD object ids),
  the Teams roster must return `userPrincipalName` or `email` for you, and your tenant's
  SharePoint/OneDrive sharing and sensitivity-label policies must allow the in-organization invite.

### Word `@mention` comment replies

`@mention`ing the agent on a comment in a shared Word document is delivered on the agents
channel as a `WpxComment` notification. Only that combination (agents channel + `WpxComment`
entity) takes the Word path; ordinary Teams `@mentions` are handled as normal chat. The agent
([src/agent.ts](src/agent.ts)) reads the document once, posts a reply on **that** comment via
`ReplyToComment`, and DMs you in Teams. The DM says "I replied" only if `ReplyToComment` ran in
this turn, targeted the notified comment id, and succeeded; otherwise it says the reply didn't go
through. If the notification carries no comment id, the agent does not reply in Word and DMs you that
it couldn't identify the comment. If the turn fails (for example, Bedrock or an MCP server errors),
the agent posts nothing to the document and DMs you a short failure notice with a reference id; the
error details stay in the server log.

The document name, the commenter's display name, the comment text and the document content are
written by document users, so the agent passes them to the model inside delimited untrusted-data
blocks and the system prompt tells the model never to follow instructions found there.

### Identity & proactive messages

Proactive DM routing, UPN resolution, and the MCP agent cache are keyed by tenant + agent instance
+ AAD object id or verified UPN — never by display name. A Word comment DM requires that you have
messaged the agent in a Teams 1:1 (`personal`) chat in the same warm Lambda environment (the
maps are in memory; use durable storage such as DynamoDB keyed the same way for production). Group
chats, channels and conversations without a `personal` type are never stored as DM targets. Without
a verified mapping the DM is skipped and logged rather than sent to a guessed user.

Logs record only lengths, entity/attachment types, tool names and status — not message text,
display names, document URLs or raw tool payloads. When a turn fails, the user sees a generic
"Sorry — ..." message with a reference id instead of the exception text; search the
logs for that id to find the error. Nothing is sent back on agents-channel (Word) turns, where a reply
would fail.

### Observability

A365 OpenTelemetry is wired in [src/index.ts](src/index.ts), which registers it before loading the
rest of the app, and the per-turn
`InvokeAgentScope` in [src/agent.ts](src/agent.ts). The code attaches the **agent id**,
**blueprint id**, and, when verified, the **caller's UPN**. The span agent id comes from the activity's
`recipient.agenticAppId`; it is never the blueprint id. Export uses the S2S endpoint with an
app-only token for the agent instance ([src/observability-token-service.ts](src/observability-token-service.ts));
it never reuses the user's delegated token. The supplied `.env.example` and browser stack disable
cloud export. Enabling the exporter alone does not verify MAC Activity or Defender reporting;
validate it separately.

> The caller's UPN is present in `from.id` on agents-channel (Word comment) turns but not on direct
> 1:1 chats (which carry only the Teams MRI). The agent resolves it from the conversation roster via
> the connector client and accepts it only when the roster member's AAD object id matches the caller's.

### Conversation memory & MCP caching

A process-wide LangGraph `MemorySaver` keyed by `thread_id` gives each conversation memory, and
the MCP-enabled agent is cached per tenant + agent instance + caller (short TTL) so the ~6–10s
Word/OneDrive MCP handshake is paid once, not every turn ([src/client.ts](src/client.ts)). Each turn's
input message carries a unique id, so tool checks only see tools executed in that turn. Both live in
the memory of one Lambda environment; see [Deploying to AWS](#deploying-to-aws) for what that means
when several environments run at once.

## Deploying to AWS

`deploy-aws.ps1` hosts the messaging endpoint
on **AWS Lambda Web Functions** (a managed Node.js HTTP server with a built-in HTTPS endpoint) and
switches the LLM to **Amazon Bedrock**, called through the function's IAM role (no model keys):

```powershell
aws configure set region us-east-2
aws login
.\deploy-aws.ps1 -Region us-east-2 -UpdateA365Endpoint
```

Re-run it to ship code or setting changes; later runs publish a new revision behind the same URL.

**Prerequisites**

- AWS CLI v2 with the `aws lambda-web` commands (2.38+), signed in with `aws login`,
  `aws configure sso`, or `aws configure`. The identity must be able to manage Lambda Web Functions,
  IAM roles, and S3, and to call Bedrock.
- A `.env` with the agent's Agent 365 settings (`a365 setup all --aiteammate --m365` writes it).
  Moving an agent that already runs on Azure App Service? Export its settings instead:

  ```powershell
  az webapp config appsettings list -g <rg> -n <app> --query "[].[name,value]" -o tsv |
    ForEach-Object { $k, $v = $_ -split "`t", 2; "$k=$v" } | Set-Content .env
  ```

- Bedrock access to the model in the target region. The default model, Amazon Nova 2 Lite, needs no
  extra sign-up. Claude models need the one-time Anthropic use-case form (Bedrock console > Model
  catalog), and the first call to a third-party model subscribes the account through AWS
  Marketplace, so the script's preflight call (made as you, not the function) needs
  `aws-marketplace:Subscribe` the first time.
- For `-UpdateA365Endpoint`: the `a365` CLI, `a365.config.json` / `a365.generated.config.json` in this
  folder, and **owner** rights on the agent blueprint (a non-owner gets "not the owner").

**What the script does**

1. Checks the AWS CLI, your sign-in, and Bedrock access to the model (one short Converse call).
2. Creates or updates the IAM execution role `<FunctionName>-exec`: CloudWatch Logs
   (`AWSLambdaBasicExecutionRole`), the `bedrock-invoke` inline policy for the selected model, and the
   `secrets-read` inline policy for the agent's secret.
3. Builds a production package in a temp folder (`npm install --omit=dev`, which runs `tsc`), and
   drops type declarations and source maps so the upload stays small.
4. Stores the secret settings from `.env` in the Secrets Manager secret `<FunctionName>/agent365`
   (see [Secrets on AWS](#secrets-on-aws)), then runs `aws lambda-web deploy` with the remaining `.env`
   settings as environment variables, plus `A365_SECRETS_ARN`, `LLM_PROVIDER=bedrock`,
   `BEDROCK_MODEL_ID`, `BEDROCK_REGION`, and `NODE_ENV=production`. Azure
   OpenAI / OpenAI keys, `AWS_*` names, `PORT`, `BEARER_TOKEN`, and `ENABLE_TEST_ENDPOINT` are never
   shipped, and `.env` itself is never packaged. After deploying, it checks that no secret setting
   name is left in the function's environment.
5. Waits for `GET /api/health` to return 200 and checks that `POST /api/messages` without a token
   returns 401. If it accepts the unauthenticated call (HTTP 2xx), the script stops with an error and
   does not update the blueprint endpoint.
6. With `-UpdateA365Endpoint`, runs `a365 setup blueprint --update-endpoint <url>/api/messages --m365`.

| Parameter | Default | Description |
|---|---|---|
| `-FunctionName` | `travelagentdw` | Web Function name; the IAM role is `<name>-exec` |
| `-Region` | your AWS CLI Region | `AWS_REGION` / `AWS_DEFAULT_REGION` / `aws configure get region`, else `us-east-1`. Needs Lambda Web Functions + Bedrock (at launch: `us-east-1`, `us-east-2`, `us-west-2`, `eu-west-1`, `ap-northeast-1`) |
| `-ModelId` | `<geo>.amazon.nova-2-lite-v1:0` | Bedrock model or inference profile id. The default uses the `us.`, `eu.`, or `global.` profile matching `-Region` (`us.` profiles only work from US Regions) and works without any extra sign-up. For Claude, submit the Anthropic use-case form once, then use e.g. `us.anthropic.claude-sonnet-4-6` (new AWS accounts may not get the Claude 5.x models, such as `us.anthropic.claude-sonnet-5-5`, right away) |
| `-LlmProvider` | `Bedrock` | `AzureOpenAI` uses an Azure AI Foundry / Azure OpenAI deployment instead of Bedrock (see below); `-ModelId` is then ignored |
| `-TenantSecretPrefix` | none | Multi-tenant mode: serve every blueprint registered with `register-tenant.ps1` under this Secrets Manager prefix, e.g. `travelagent/tenants/` (see [One backend for many tenants](#one-backend-for-many-tenants-multi-tenant-mode)) |
| `-DisableMultiTenant` | off | Turn a multi-tenant backend back into a single-tenant one |
| `-AwsProfile` | default chain | AWS CLI profile to deploy with |
| `-EnvFile` | `.env` | Settings to ship |
| `-EndpointName` | `prod` | Web Function endpoint name |
| `-TimeoutSeconds` | `300` | Per-request timeout (30–900); tool-heavy turns can run long |
| `-SettingsOnly` | off | Publish the `-EnvFile` settings as a new revision that reuses the deployed code (no build or upload), e.g. after `a365 setup` writes new blueprint credentials. Also refreshes the Secrets Manager secret and the role's `bedrock-invoke` and `secrets-read` policies. The first deploy after upgrading from a version without Secrets Manager support must be a full deploy |
| `-UpdateA365Endpoint` | off | Point the agent blueprint at the new endpoint |
| `-SkipModelCheck` | off | Skip the model preflight call (Bedrock, or the Azure OpenAI deployment with `-LlmProvider AzureOpenAI`) |
| `-TailLogs` | off | Stream logs after deploying |

**Use Azure AI Foundry (Azure OpenAI) instead of Bedrock**

New AWS accounts can start with Amazon Bedrock quotas of 0 in every Region until AWS reviews the
account (calls fail with `ThrottlingException`). The agent can call an Azure OpenAI model deployment
instead; the endpoint still runs on AWS Lambda. Add these to `.env` (from your Foundry or Azure
OpenAI resource: **Keys and Endpoint**, and **Deployments**):

```bash
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com/
AZURE_OPENAI_DEPLOYMENT=<deployment name, e.g. gpt-4o-mini>
AZURE_OPENAI_API_KEY=<key>
# AZURE_OPENAI_API_VERSION=2024-12-01-preview
```

Then deploy (or switch an existing deployment) with:

```powershell
./deploy-aws.ps1 -LlmProvider AzureOpenAI -UpdateA365Endpoint
./deploy-aws.ps1 -LlmProvider AzureOpenAI -SettingsOnly   # switch without rebuilding
```

The script checks the deployment with one call, stores the API key in the Secrets Manager secret
(never in the function settings), and removes the role's `bedrock-invoke` policy. Switch back with
`./deploy-aws.ps1 -SettingsOnly` (Bedrock is the default). Prompts and replies are then processed
by Azure OpenAI, not AWS. The CloudFormation template supports Bedrock only.

**Operate**

In the AWS console, open **Lambda** in the deployment Region and choose **Web Functions** in the
navigation pane. Web Functions aren't listed under **Functions**.

```powershell
# Logs
aws logs tail /aws/lambda/web/travelagentdw --follow --region us-east-2

# What's live: the revision behind the endpoint and its settings. Secrets aren't in the function
# settings; they're in the Secrets Manager secret travelagentdw/agent365.
$rev = aws lambda-web get-web-function-endpoint --function-name travelagentdw --endpoint-name prod --region us-east-2 --query "revisionWeights[0].revisionId" --output text
aws lambda-web get-web-function-revision --function-name travelagentdw --revision-id $rev --region us-east-2 --query "{revision:revisionId, model:serviceConfig.environmentVariables.BEDROCK_MODEL_ID, timeoutSeconds:serviceConfig.timeoutSeconds, role:serviceConfig.executionRoleArn}" --output table

# Change settings or the model without rebuilding (e.g. Claude, once the Anthropic form is in)
./deploy-aws.ps1 -SettingsOnly -ModelId us.anthropic.claude-sonnet-4-6

# Remove the AWS resources
aws lambda-web delete-web-function --function-name travelagentdw --region us-east-2
aws secretsmanager delete-secret --secret-id travelagentdw/agent365 --force-delete-without-recovery --region us-east-2
aws iam delete-role-policy --role-name travelagentdw-exec --policy-name secrets-read
aws iam delete-role-policy --role-name travelagentdw-exec --policy-name bedrock-invoke
aws iam detach-role-policy --role-name travelagentdw-exec --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role --role-name travelagentdw-exec
```

`delete-web-function` leaves the deployment packages (managed bucket
`awscli-lambdaweb-<account-id>-<region>-an`, prefix `lambda-web/travelagentdw/`) and the
`/aws/lambda/web/travelagentdw` and `/aws/lambda/web/travelagentdw.local` log groups in place.
Remove the log groups if no longer needed; while they exist, they also block a later Launch Stack
deployment that uses the same function name in that Region. The package bucket is shared by CLI-deployed Web
Functions in that account and Region; do not delete it while another Web Function uses it.

> Conversation memory, the MCP agent cache, and proactive-DM conversation references live in process
> memory. A Web Function environment serves many concurrent requests and keeps that state while warm,
> but it resets when the function scales to zero after idling — the same as an App Service restart.
> Lambda can also run several environments at once (up to **Maximum environments**, default 5), and
> each keeps its own memory. A follow-up turn routed to a different environment won't see earlier
> conversation memory, the MCP agent cache, or a stored DM reference. The proactive-DM maps and the MCP
> cache have TTL and size limits; the LangGraph `MemorySaver` and the hosting `MemoryStorage` keep data
> until the environment is recycled. For production, use durable storage, such as a DynamoDB- or
> S3-backed LangGraph checkpointer and Agents SDK storage.
> Lambda also requires the server to start listening within 10 seconds of a cold start.

> Lambda's managed Node.js runtimes disable `require()` of ES modules, which `jwks-rsa` (used by
> `@microsoft/agents-hosting` to validate tokens) needs for the ESM-only `jose`. The function
> therefore starts from [src/lambda.ts](src/lambda.ts), which loads
> [src/require-esm-compat.ts](src/require-esm-compat.ts), then `secrets.ts` (settings from Secrets
> Manager), then the app. To reproduce Lambda's
> behavior locally, run `node --no-experimental-require-module dist/lambda.js`.

### One backend for many tenants (multi-tenant mode)

One deployment can serve agent blueprints from many Microsoft 365 tenants (for example, one agent
per customer or per lab participant). Each blueprint keeps its own credentials, registered once in
AWS Secrets Manager; nobody copies secrets by hand.

**How it works.** Every registration is a secret named `<prefix><tenantId>/<blueprintId>` holding
`{"tenantId","blueprintId","clientSecret"}`. At cold start, [src/secrets.ts](src/secrets.ts) reads all
secrets under `A365_TENANT_SECRETS_PREFIX`, and [src/tenant-registry.ts](src/tenant-registry.ts) turns
each into an Agents SDK connection plus a `connectionsMap` entry whose `audience` is the blueprint id.
The SDK then accepts an incoming request only if its token was issued for a registered blueprint, and
uses the same blueprint for replies and agent-user tokens (WorkIQ, Word, OneDrive). The app also
rejects (403) an activity whose tenant differs from the tenant registered for the token's blueprint.
A registration must be named exactly `<prefix><tenantId>/<blueprintId>` for the ids inside it. If two
registrations name the same blueprint, the backend keeps only the one whose credentials can get a token
as that blueprint in its tenant (proving ownership); if that doesn't settle it, both are skipped and
logged as a conflict. `agentic_altBlueprintConnectionName` is removed in this mode
because it pins every agent token to one blueprint. Caches, proactive-DM references and the
document-access guard are already keyed by tenant and agent.

**1. Deploy the shared backend once** (from any tenant's folder, or with a `.env` that has only the
non-connection settings):

```powershell
.\deploy-aws.ps1 -Region us-east-2 -TenantSecretPrefix travelagent/tenants/ -LlmProvider AzureOpenAI
```

The role gets an extra inline policy, `tenant-secrets-read`: `secretsmanager:GetSecretValue` on
`travelagent/tenants/*` only, plus `ListSecrets`/`BatchGetSecretValue` (which AWS doesn't scope by
resource). Note the printed messaging endpoint.

**2. Register each tenant** (whoever sets up that tenant; needs `a365`, Azure CLI, and AWS CLI access):

```powershell
az login --tenant contoso.onmicrosoft.com
.\register-tenant.ps1 -AgentName Travel-contoso -Region us-east-2 `
    -MessagingEndpoint https://<backend-url>/api/messages -RemoveLocalSecret
```

It runs `a365 setup all`, stores the blueprint's credentials as `travelagent/tenants/<tenantId>/<blueprintId>`
from an owner-only temp file, points the blueprint at the shared endpoint, and (with
`-RemoveLocalSecret`) blanks the secret in the local `.env`. Use `-SkipSetup` to register an agent that
`a365 setup` already created. Then complete the usual per-tenant steps: approve the agent, give the
agent user a license that includes OneDrive, and hire it in Teams.

Give each person who registers tenants write-only access to **their own tenant's** registrations (no
read, and no access to other tenants' names):

```json
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow",
  "Action": ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:DescribeSecret",
             "secretsmanager:RestoreSecret", "secretsmanager:TagResource"],
  "Resource": "arn:aws:secretsmanager:us-east-2:<account-id>:secret:travelagent/tenants/<tenantId>/*" }] }
```

If one team registers every tenant, scope it to `travelagent/tenants/*` instead.

**3. Pick up new registrations.** Running environments keep the tenant list they loaded at cold start.
New environments load the latest list automatically; to serve a new tenant right away, publish a new
revision:

```powershell
.\deploy-aws.ps1 -Region us-east-2 -TenantSecretPrefix travelagent/tenants/ -SettingsOnly
```

**Operate.** Offboard a tenant by deleting its secret (`aws secretsmanager delete-secret --secret-id
travelagent/tenants/<tenantId>/<blueprintId>`) and restarting as above. Rotate a blueprint secret with
`a365` in that tenant, then `register-tenant.ps1 -SkipSetup` (a registration replaces the secret of a
`.env` connection for the same blueprint and tenant). Plan capacity for all tenants together:
LLM quota (Bedrock or Azure OpenAI tokens per minute) and **Maximum environments**. One backend is
also one blast radius: a bad deploy affects every tenant. Once a backend is multi-tenant, every
`deploy-aws.ps1` run must pass `-TenantSecretPrefix` (the script refuses otherwise); pass
`-DisableMultiTenant` instead to turn the mode off.

> Multi-tenant mode needs a full deploy of this version first (`-SettingsOnly` reuses the deployed
> code). The Agent 365 observability exporter takes one blueprint's `AGENT365_OBS_*` settings, so keep
> `ENABLE_A365_OBSERVABILITY_EXPORTER=false` in this mode unless you only need one tenant's telemetry.
> The CloudFormation template deploys single-tenant only.

### One-click deploy without tools (CloudFormation "Launch Stack")

`deploy-aws.ps1` needs a developer machine. For people who only have an AWS console sign-in, publish
the agent once as a CloudFormation template; they then deploy from a link in about 2 minutes, with no
tools, files, or terminal. Each deployment is self-contained in its own AWS account.

**Hand-out guide:** [aws/DEPLOY-GUIDE.md](aws/DEPLOY-GUIDE.md) walks the people deploying through every
click, and walks admins through preparing and connecting each agent.

**1. Publish (once per release, by the maintainer)**

```powershell
aws login
./aws/publish-launch-stack.ps1 -Share Public                                # anyone with the link
./aws/publish-launch-stack.ps1 -Share Organization -OrganizationId o-xxxx   # your AWS Organization only
```

The script builds the package once, uploads it with [aws/travelagentdw.cfn.yaml](aws/travelagentdw.cfn.yaml)
to `s3://travelagentdw-releases-<account-id>-<region>/travelagentdw/<version>/`, and prints a Launch
Stack link for each Lambda Web Functions Region. The package and template contain no secrets; each
person enters their agent's values when they deploy. The default, `-Share Account`, limits the links
to your own account, for testing. Sharing applies only to this version's package and template; other
versions keep the access they already have. The link carries the package's SHA-256, and the stack
refuses a package whose hash doesn't match the release.

**2. Deploy (each person)**

They need an AWS sign-in that can create IAM roles (for example, the account's administrator) and three
values from the Agent 365 admin: the agent blueprint ID, its client secret, and the Microsoft 365
tenant ID (from `a365.generated.config.json` and `.env` after `a365 setup all`).

1. Open the Launch Stack link and sign in to the AWS account to deploy into.
2. Fill in **Agent blueprint ID**, **Agent blueprint client secret**, and **Microsoft 365 tenant ID**.
3. Select **I acknowledge that AWS CloudFormation might create IAM resources**, then **Create stack**.
4. When the status is **CREATE_COMPLETE** (about 2 minutes), open the **Outputs** tab and send
   **MessagingEndpoint** to the Agent 365 admin. **HealthCheck** opens a page that shows
   `{"status":"healthy"}`.

To switch models later: **Update stack** > **Use existing template** > **Bedrock model ID**. To remove
everything: **Delete stack**.

**3. Connect (Agent 365 admin, per agent)**

Run the stack's **AdminCommand** output (`a365 setup blueprint --update-endpoint <MessagingEndpoint> --m365`),
then publish and hire the agent as usual (`a365 publish`, upload `manifest.zip` in the Microsoft 365
admin center, request and approve the instance).

**What each deployment creates:** the Web Function (`travelagentdw`, endpoint `prod`, capped at
**Maximum environments**, default 5); its IAM execution role (CloudWatch Logs, Bedrock invoke for the
selected model, and read access to the agent's secret only); a Secrets Manager secret, owned by the
stack, that holds the blueprint client secret (the function gets only its ARN, `A365_SECRETS_ARN`);
a private, versioned S3 bucket with that account's copy of the code, so later releases or deleting the
publisher's copy never affect it; a small Lambda function that copies the package in and empties the
bucket when the stack is deleted; and log groups that keep logs for 30 days.

> A brand-new AWS account can't call Bedrock until AWS finishes verifying it (usually under 2 hours);
> the agent starts answering once that's done. Amazon Nova 2 Lite needs no sign-up. Claude models
> need the Anthropic use-case form once per account.

To deploy to many accounts in one AWS Organization without sending links, an admin can use
CloudFormation StackSets (service-managed permissions) with the printed template URL, giving each
account its own blueprint values as per-account parameter overrides
(`aws cloudformation create-stack-instances --deployment-targets Accounts=<id> --parameter-overrides ...`),
then collect each stack's **MessagingEndpoint** output for the Agent 365 admin.

## Production hardening

This is a sample. Before running it for real users:

- **Secrets** — secret settings live in AWS Secrets Manager, not in function settings (see
  [Secrets on AWS](#secrets-on-aws)). Revisions deployed by earlier versions of this sample still hold
  the blueprint client secret in their environment, so upgrade with a full deploy (not `-SettingsOnly`)
  and then rotate the blueprint client secret. Secrets Manager costs about $0.40 per secret per month plus API calls.
- **State** — conversation memory, the MCP agent cache, owned-document records and DM references are
  in memory per Lambda environment. Use durable storage (for example, a DynamoDB- or S3-backed
  LangGraph checkpointer and Agents SDK storage) if follow-ups must survive cold starts or land on
  another environment.
- **Endpoints** — only `GET /api/health` is unauthenticated; there is no test endpoint to disable.
  `/api/messages` validates Agent 365 tokens, and the deploy script refuses an endpoint that accepts
  unauthenticated calls.
- **Least privilege** — the execution role can invoke only the selected Bedrock model and read only
  this agent's secret. Documents are shared only with the verified requester, and the Word tools work
  only on documents the agent created for that requester or on the notified comment's document.
- **Logs and errors** — in production (`NODE_ENV=production`, as on Lambda) logs carry metadata only:
  lengths, tool names, decisions, and for errors just the error name, status and code — never error
  messages, prompts or tool output. Set `DEBUG=1` to get full error detail while troubleshooting, then
  remove it. Users see a generic error with a reference id. Keep CloudWatch log retention and access
  in line with your policy.
- **Observability** — cloud export is off by default. Before enabling it, configure the
  `AGENT365_OBS_*` settings and validate that activity reaches your reporting.

## Project structure

```
src/
  index.ts               Entry point — loads .env, registers OpenTelemetry, then imports app.ts
  app.ts                 Express host, CloudAdapter, /api/health and /api/messages
  lambda.ts              AWS Lambda entry — loads require-esm-compat.ts, secrets.ts, then index.ts
  require-esm-compat.ts  Lets CommonJS dependencies require() ESM-only packages on Lambda
  secrets.ts             Loads secret settings from AWS Secrets Manager (A365_SECRETS_ARN) and tenant registrations (A365_TENANT_SECRETS_PREFIX) at Lambda cold start
  tenant-registry.ts     Multi-tenant mode: turns registered blueprints into connections routed by token audience
  agent.ts               AgentApplication: message + notification handlers, scopes, document sharing
  activity-helpers.ts    Word comment detection, span agent id, turn correlation id, share failure note
  client.ts              LangChain agent factory, system prompt, MCP wiring, identity-scoped cache
  prompt-safety.ts       Wraps untrusted text (comments, names) in delimited blocks for the model
  log.ts                 Production-safe logging: metadata only unless DEBUG is set
  tool-results.ts        Reads this turn's tool results (multi-block MCP output) and created files
  mcp-tool-policy.ts     Allow-list of MCP tools the model may call (no OneDrive list/read/delete/share); code-driven share
  document-access.ts     Limits Word tools to the requester's own documents or the notified document
  identity.ts            Tenant/agent/caller-scoped identity keys (no display names)
  observability-token-service.ts  App-only OBS token resolver for S2S export
  mcp-tool-service.ts    Shared WorkIQ MCP tool registration service
  tools/                 SearchFlights / SearchHotels / SearchRestaurants
test/                    Unit tests (`npm test`)
manifest/                Generated by `a365 publish` (git-ignored, not committed)
deploy-aws.ps1           AWS Lambda Web Functions + Amazon Bedrock deploy script
register-tenant.ps1      Registers one tenant's blueprint with a shared multi-tenant backend
aws/
  DEPLOY-GUIDE.md          Step-by-step guide for people deploying from a Launch Stack link
  travelagentdw.cfn.yaml   CloudFormation template for one-click (Launch Stack) deployments
  publish-launch-stack.ps1 Builds the package once, uploads it with the template, prints the links
package.json             Dependencies; axios is listed because @microsoft/agents-a365-tooling requires it without declaring it
ToolingManifest.json     WorkIQ MCP servers (mcp_WordServer, mcp_OneDriveRemoteServer)
.env.example             Safe configuration template; setup fills your local .env
```

## Troubleshooting

| Symptom | What to check |
|---|---|
| `aws` or `lambda-web` is not found | Install/update AWS CLI v2, reopen the terminal, and check `aws --version` and `aws lambda-web help`. |
| PowerShell says running scripts is disabled | If permitted by your organization, run `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`, then retry. This applies only to the current terminal. |
| Missing `.env` or Agent 365 connection settings | Complete step 2 in this folder. Confirm the connection client ID, client secret, and tenant ID are populated; do not post their values in logs or issues. |
| AWS sign-in or permission error | Run `aws login`, then `aws sts get-caller-identity`. The identity needs Web Functions, IAM, S3, CloudWatch Logs, and Bedrock permissions. |
| Bedrock says the account is being verified | Wait for AWS account verification, then retry. `-SkipModelCheck` can deploy the endpoint earlier but does not make the model available. |
| Every message fails with `ThrottlingException status=429` in the logs | The account's Bedrock quotas are 0 or too low (common for new accounts in every Region). Check with `aws service-quotas list-service-quotas --service-code bedrock --region <region>`, request an increase through Service Quotas or AWS Support, or deploy with `-LlmProvider AzureOpenAI`. |
| Bedrock model access error | Use the Region-compatible inference profile. For Claude, complete the account's Anthropic use-case form and first-use Marketplace subscription requirements. |
| Function is healthy but Teams is silent | Confirm the blueprint endpoint and Developer Portal notification URL match, the instance is approved, and the connection credentials belong to this blueprint. Tail CloudWatch logs while sending a message. |
| Agent is missing from the Lambda **Functions** list | Select **Web Functions** in the correct Region instead. |
| Word comment reply has no proactive Teams message | Chat directly with the agent first so it can store your personal conversation reference. The in-memory reference resets after a cold start and is not shared between concurrent environments. Look for `[Proactive] No verified 1:1 mapping` in the logs. |
| Startup fails with `Failed to load settings from A365_SECRETS_ARN` | The function couldn't read its Secrets Manager secret. Confirm `travelagentdw/agent365` exists in the function's Region and that the `travelagentdw-exec` role has the `secrets-read` policy, then re-run `.\deploy-aws.ps1 -SettingsOnly`. |
| Startup fails with `Failed to load tenant registrations` | Multi-tenant mode found no valid registration or couldn't read them. Check the `[Tenants]` log lines, that secrets exist under the prefix in the function's Region, and that the role has the `tenant-secrets-read` policy (re-run `deploy-aws.ps1 -TenantSecretPrefix ...`). |
| One tenant's agent gets 401s while others work | Its blueprint isn't registered, or the backend hasn't restarted since registration. Run `register-tenant.ps1 -SkipSetup` in that tenant's folder, then `.\deploy-aws.ps1 -TenantSecretPrefix <prefix> -SettingsOnly`. |
| Health check passes but every message fails | Check CloudWatch for `[LLM] Configuration error` (for example, a missing `BEDROCK_MODEL_ID`), fix the setting, and re-run with `-SettingsOnly`. |
| Agent says "Access denied" for a Word document | The Word tools only work on documents the agent created for you (in the same warm environment, within 24 hours) or on the document from the comment you @mentioned it in. Ask the agent to create the document, or @mention it on a comment in that document. |
| The user sees "Sorry — ..." with a reference id | Search the CloudWatch logs for that reference id to find the server-side error. |
| Document created but you see "Request access", or the reply says it could not grant access | Search the CloudWatch logs for the reply's reference id and check the `[Share]` lines (set `DEBUG=1` for full error detail). Confirm `shareFileOrFolderInMyOnedrive` appears in the `[MCP] Withheld from model` log (the code calls it directly), that `[Caller] ... verifiedUpn=present`, and that tenant sharing policy allows the invite. |
| Reply says a document was created but couldn't be identified | The create tool's result had no driveItem id in any text block or structured content. Check the `[Tools]` and `[Share]` log lines; nothing was shared and no broader link was created. |
| Reply says your work account couldn't be verified | The Teams roster did not return a UPN/email with a matching AAD object id. Chat 1:1 with the agent (not in a group) and retry. |
| Startup fails with `AGENT365_OBS_...` | `ENABLE_A365_OBSERVABILITY_EXPORTER=true` requires all four `AGENT365_OBS_*` settings with real values; set it to `false` to run without cloud export. |

## Additional resources

- [Microsoft Agent 365 SDK — Node.js](https://github.com/microsoft/Agent365-nodejs)
- [Microsoft 365 Agents SDK — Node.js](https://github.com/Microsoft/Agents-for-js)
- [Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- [LangChain documentation](https://js.langchain.com/)

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use
of Microsoft trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion
or imply Microsoft sponsorship.
