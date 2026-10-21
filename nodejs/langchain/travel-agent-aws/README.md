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

   Before this sample is merged into `main`, use
   `git clone --branch add-travel-agent-aws --single-branch https://github.com/microsoft/Agent365-Samples.git`
   instead of the clone command above.

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
   The script builds the app, deploys it, checks health (HTTP 200) and authentication
   (unauthenticated messages return HTTP 401), and registers the printed **Messaging endpoint**
   with the blueprint. If your setup tool changes `.env` afterward, send the final settings with
   `.\deploy-aws.ps1 -FunctionName travelagentdw -Region us-east-2 -SettingsOnly`.

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

   | Variable | Description |
   |---|---|
   | `AZURE_OPENAI_API_KEY` | Azure OpenAI key (preferred path) |
   | `AZURE_OPENAI_ENDPOINT` | e.g. `https://<resource>.openai.azure.com/` |
   | `AZURE_OPENAI_DEPLOYMENT` | Deployment name (e.g. `gpt-5.4-mini`) |
   | `AZURE_OPENAI_API_VERSION` | e.g. `2024-12-01-preview` |
   | `OPENAI_API_KEY` / `OPENAI_MODEL` | Used only if the Azure block is incomplete |
   | `LLM_PROVIDER` | Optional: `bedrock` uses Amazon Bedrock (set by `deploy-aws.ps1`); `openai` skips the Azure block |
   | `BEDROCK_MODEL_ID` | Bedrock model or inference profile id (e.g. `us.amazon.nova-2-lite-v1:0`, `us.anthropic.claude-sonnet-4-6`) |
   | `BEDROCK_REGION` / `BEDROCK_MAX_TOKENS` | Bedrock region (default `AWS_REGION`, then `us-east-1`) / max output tokens incl. model reasoning (default 8192) |
   | `connections__service_connection__settings__clientId` / `clientSecret` / `tenantId` | Blueprint connection for `/api/messages` auth; setup populates these three settings |
   | `agentic_*` | Agentic auth handler settings (written by `a365 setup all`) |
   | `agent365Observability__agentId` | Agent instance id (`recipient.agenticAppId`), used on spans when the activity lacks it |
   | `agent365Observability__agentBlueprintId` | Blueprint id stamped on spans for blueprint-level activity |
   | `agent365Observability__tenantId` | Tenant id |
   | `ENABLE_A365_OBSERVABILITY_EXPORTER` | `false` by default. When `true`, spans export over the S2S endpoint with an app-only token and the four `AGENT365_OBS_*` settings below are required (startup fails if any is missing or a placeholder) |
   | `AGENT365_OBS_TENANT_ID` / `AGENT365_OBS_AGENT_ID` | Tenant and agent **instance** client id that export is allowed for; must match the activity's `recipient.tenantId` / `recipient.agenticAppId` |
   | `AGENT365_OBS_BLUEPRINT_CLIENT_ID` / `AGENT365_OBS_BLUEPRINT_CLIENT_SECRET` | Blueprint credential used only to acquire the app-only OBS token (FMI chain). Store the secret in AWS Secrets Manager / SSM for production rather than a plain Lambda environment variable |
   | `SHARE_SEND_INVITATION` | `true` by default; set `false` to grant edit access to created documents without the OneDrive invitation email |

   > `a365 setup all --aiteammate --m365` populates most of the A365 keys automatically.
   > To use Amazon Bedrock locally, set `LLM_PROVIDER=bedrock` and `BEDROCK_MODEL_ID`; the AWS SDK
   > picks up your AWS CLI sign-in (`aws login`, SSO profile, or `AWS_PROFILE`).

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

For live-reload development:

```bash
npm run dev   # tsx watch (ESM TypeScript, auto-restart, Node inspector on 9239)
```

Unit tests (tool-result parsing and the MCP tool policy, no credentials needed):

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
document was created but could not be identified or shared).

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
  item created in the current turn. Word tools that take a document URL can reach any document the
  agent's account can open, so treat document links as sensitive.
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
it couldn't identify the comment.

### Identity & proactive messages

Proactive DM routing, UPN resolution, and the MCP agent cache are keyed by tenant + agent instance
+ AAD object id or verified UPN — never by display name. A Word comment DM requires that you have
messaged the agent in a Teams 1:1 (`personal`) chat since the current Lambda instance started (the
maps are in memory; use durable storage such as DynamoDB keyed the same way for production). Group
chats, channels and conversations without a `personal` type are never stored as DM targets. Without
a verified mapping the DM is skipped and logged rather than sent to a guessed user.

Logs record only lengths, entity/attachment types, tool names and status — not message text,
display names, document URLs or raw tool payloads.

### Observability

A365 OpenTelemetry is wired in [src/index.ts](src/index.ts) and the per-turn
`InvokeAgentScope` in [src/agent.ts](src/agent.ts). The code attaches the **agent id**,
**blueprint id**, and, when verified, the **caller's UPN**. Export uses the S2S endpoint with an
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
input message carries a unique id, so tool checks only see tools executed in that turn.

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
2. Creates or updates the IAM execution role `<FunctionName>-exec` (CloudWatch Logs +
   `bedrock:InvokeModel`).
3. Builds a production package in a temp folder (`npm install --omit=dev`, which runs `tsc`), and
   drops type declarations and source maps so the upload stays small.
4. Runs `aws lambda-web deploy` with the `.env` settings as environment variables, plus
   `LLM_PROVIDER=bedrock`, `BEDROCK_MODEL_ID`, `BEDROCK_REGION`, and `NODE_ENV=production`. Azure
   OpenAI / OpenAI keys, `AWS_*` names, `PORT`, `BEARER_TOKEN`, and `ENABLE_TEST_ENDPOINT` are never
   shipped, and `.env` itself is never packaged.
5. Waits for `GET /api/health` to return 200 and checks that `POST /api/messages` without a token
   returns 401.
6. With `-UpdateA365Endpoint`, runs `a365 setup blueprint --update-endpoint <url>/api/messages --m365`.

| Parameter | Default | Description |
|---|---|---|
| `-FunctionName` | `travelagentdw` | Web Function name; the IAM role is `<name>-exec` |
| `-Region` | your AWS CLI Region | `AWS_REGION` / `AWS_DEFAULT_REGION` / `aws configure get region`, else `us-east-1`. Needs Lambda Web Functions + Bedrock (at launch: `us-east-1`, `us-east-2`, `us-west-2`, `eu-west-1`, `ap-northeast-1`) |
| `-ModelId` | `<geo>.amazon.nova-2-lite-v1:0` | Bedrock model or inference profile id. The default uses the `us.`, `eu.`, or `global.` profile matching `-Region` (`us.` profiles only work from US Regions) and works without any extra sign-up. For Claude, submit the Anthropic use-case form once, then use e.g. `us.anthropic.claude-sonnet-4-6` (new AWS accounts may not get the Claude 5.x models, such as `us.anthropic.claude-sonnet-5-5`, right away) |
| `-AwsProfile` | default chain | AWS CLI profile to deploy with |
| `-EnvFile` | `.env` | Settings to ship |
| `-EndpointName` | `prod` | Web Function endpoint name |
| `-TimeoutSeconds` | `300` | Per-request timeout (30–900); tool-heavy turns can run long |
| `-SettingsOnly` | off | Publish the `-EnvFile` settings as a new revision that reuses the deployed code (no build or upload), e.g. after `a365 setup` writes new blueprint credentials |
| `-UpdateA365Endpoint` | off | Point the agent blueprint at the new endpoint |
| `-SkipModelCheck` | off | Skip the Bedrock preflight call (keep it on for an account's first use of the model) |
| `-TailLogs` | off | Stream logs after deploying |

**Operate**

In the AWS console, open **Lambda** in the deployment Region and choose **Web Functions** in the
navigation pane. Web Functions aren't listed under **Functions**.

```powershell
# Logs
aws logs tail /aws/lambda/web/travelagentdw --follow --region us-east-2

# What's live: the revision behind the endpoint and its settings (omit --query and the
# output includes the blueprint client secret)
$rev = aws lambda-web get-web-function-endpoint --function-name travelagentdw --endpoint-name prod --region us-east-2 --query "revisionWeights[0].revisionId" --output text
aws lambda-web get-web-function-revision --function-name travelagentdw --revision-id $rev --region us-east-2 --query "{revision:revisionId, model:serviceConfig.environmentVariables.BEDROCK_MODEL_ID, timeoutSeconds:serviceConfig.timeoutSeconds, role:serviceConfig.executionRoleArn}" --output table

# Change settings or the model without rebuilding (e.g. Claude, once the Anthropic form is in)
./deploy-aws.ps1 -SettingsOnly -ModelId us.anthropic.claude-sonnet-4-6

# Remove the AWS resources
aws lambda-web delete-web-function --function-name travelagentdw --region us-east-2
aws iam delete-role-policy --role-name travelagentdw-exec --policy-name bedrock-invoke
aws iam detach-role-policy --role-name travelagentdw-exec --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role --role-name travelagentdw-exec
```

`delete-web-function` leaves the deployment packages (managed bucket
`awscli-lambdaweb-<account-id>-<region>-an`, prefix `lambda-web/travelagentdw/`) and the
`/aws/lambda/web/travelagentdw` and `/aws/lambda/web/travelagentdw.local` log groups in place.
Remove the log groups if no longer needed. The package bucket is shared by CLI-deployed Web
Functions in that account and Region; do not delete it while another Web Function uses it.

> Conversation memory, the MCP agent cache, and proactive-DM conversation references live in process
> memory. A Web Function environment serves many concurrent requests and keeps that state while warm,
> but it resets when the function scales to zero after idling — the same as an App Service restart.
> Lambda also requires the server to start listening within 10 seconds of a cold start.

> Lambda's managed Node.js runtimes disable `require()` of ES modules, which `jwks-rsa` (used by
> `@microsoft/agents-hosting` to validate tokens) needs for the ESM-only `jose`. The function
> therefore starts from [src/lambda.ts](src/lambda.ts), which loads
> [src/require-esm-compat.ts](src/require-esm-compat.ts) before the app. To reproduce Lambda's
> behavior locally, run `node --no-experimental-require-module dist/lambda.js`.

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
to your own account, for testing.

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
**Maximum environments**, default 5); its IAM execution role (CloudWatch Logs and Bedrock invoke only);
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

## Project structure

```
src/
  index.ts               Entry point — observability init, Express host, /api/messages
  lambda.ts              AWS Lambda entry — loads require-esm-compat.ts, then index.ts
  require-esm-compat.ts  Lets CommonJS dependencies require() ESM-only packages on Lambda
  agent.ts               AgentApplication: message + notification handlers, scopes, document sharing
  client.ts              LangChain agent factory, system prompt, MCP wiring, identity-scoped cache
  tool-results.ts        Reads this turn's tool results (multi-block MCP output) and created files
  mcp-tool-policy.ts     Allow-list of MCP tools the model may call (no OneDrive list/read/delete/share)
  identity.ts            Tenant/agent/caller-scoped identity keys (no display names)
  observability-token-service.ts  App-only OBS token resolver for S2S export
  mcp-tool-service.ts    Shared WorkIQ MCP tool registration service
  tools/                 SearchFlights / SearchHotels / SearchRestaurants
  agent/                 travelAgent helper
test/                    Unit tests (`npm test`)
manifest/                Teams/A365 app manifest + icons (color.png, outline.png)
deploy-aws.ps1           AWS Lambda Web Functions + Amazon Bedrock deploy script
aws/
  DEPLOY-GUIDE.md          Step-by-step guide for people deploying from a Launch Stack link
  travelagentdw.cfn.yaml   CloudFormation template for one-click (Launch Stack) deployments
  publish-launch-stack.ps1 Builds the package once, uploads it with the template, prints the links
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
| Bedrock model access error | Use the Region-compatible inference profile. For Claude, complete the account's Anthropic use-case form and first-use Marketplace subscription requirements. |
| Function is healthy but Teams is silent | Confirm the blueprint endpoint and Developer Portal notification URL match, the instance is approved, and the connection credentials belong to this blueprint. Tail CloudWatch logs while sending a message. |
| Agent is missing from the Lambda **Functions** list | Select **Web Functions** in the correct Region instead. |
| Word comment reply has no proactive Teams message | Chat directly with the agent first so it can store your personal conversation reference. The in-memory reference resets after a cold start. Look for `[Proactive] No verified 1:1 mapping` in the logs. |
| Document created but you see "Request access", or the reply says it could not grant access | Check the `[Share]` log lines and the error in the reply. Confirm `shareFileOrFolderInMyOnedrive` appears in the `[MCP] Withheld from model` log (the code calls it directly), that `[Caller] ... verifiedUpn=present`, and that tenant sharing policy allows the invite. |
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
