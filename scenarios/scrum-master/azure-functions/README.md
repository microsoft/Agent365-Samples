# Scrum Master Assistant — Azure Functions

Two timer-triggered functions that drive the SMA scheduled ceremonies. The agent process (in [`../openai/sample-agent`](../openai/sample-agent)) owns all state, tokens, and Adaptive Card logic — these functions only *nudge* it via HTTP.

| Function | NCRONTAB | Local time | Calls |
|---|---|---|---|
| **StandupTimer** | `0 30 3 * * 1-5` (UTC) | 09:00 Asia/Kolkata, Mon–Fri | `POST {AGENT_CALLBACK_URL}/api/internal/standup-trigger` |
| **NightlyTimer** | `0 0 19 * * *` (UTC) | 00:30 Asia/Kolkata, daily | `POST {AGENT_CALLBACK_URL}/api/internal/nightly-check` |

## Design in one paragraph

The agent runs Express on `:3978` behind a dev tunnel (dev) or App Service / Container Apps (prod). It exposes two internal endpoints — both guarded by an `x-internal-token` header. Each Function timer wakes on schedule, POSTs to the matching endpoint, and passes the token through. The agent does the actual work (Jira REST, SharePoint writes, Adaptive Card sends). This split lets the agent stay stateful and long-lived while the timers are cheap, restart-friendly, and independently deployable.

- The agent's `LOCAL_CRON=true` in-process scheduler and this Functions app are **interchangeable**. Use one or both — `standupId = <sprintId>#<yyyy-mm-dd>` is idempotent, so a double-fire is safe.
- **Local dev** typically uses `LOCAL_CRON=true` alone and never deploys these functions.
- **Prod/demo** flips `LOCAL_CRON=false` in the agent's `.env` and deploys this Functions app so the ceremony fires on schedule without keeping a laptop alive.

## Prerequisites

- Node.js 18.x or higher
- [Azure Functions Core Tools v4](https://aka.ms/azfunc-install) — `func --version` should print `4.x.x`.
- Azure CLI — `az --version`.
- An Azure subscription + resource group.
- The agent already running somewhere reachable — either a dev tunnel URL, App Service, or Container Apps endpoint that exposes `/api/internal/*` from [`../openai/sample-agent`](../openai/sample-agent).

## Local dev

```powershell
npm install
Copy-Item local.settings.sample.json local.settings.json
# Edit local.settings.json — set:
#   AGENT_CALLBACK_URL      → your dev tunnel URL (e.g. https://<id>.devtunnels.ms)
#   INTERNAL_TRIGGER_TOKEN  → must match the value in the agent's .env
npm run build
func start
```

`func start` binds to `localhost:7071` and prints the timer schedule. You can trigger a function *right now* (bypassing the schedule) with:

```powershell
# StandupTimer
Invoke-RestMethod -Method Post `
  -Uri 'http://localhost:7071/admin/functions/StandupTimer' `
  -Headers @{ 'content-type' = 'application/json' } `
  -Body '{}'

# NightlyTimer
Invoke-RestMethod -Method Post `
  -Uri 'http://localhost:7071/admin/functions/NightlyTimer' `
  -Headers @{ 'content-type' = 'application/json' } `
  -Body '{}'
```

## Deploy to Azure

**1. Create the Function App** (once):

```powershell
$rg     = '<your-resource-group>'
$loc    = 'centralindia'
$app    = 'sma-timers-<uniquesuffix>'
$stg    = 'smatimers<uniquesuffix>'

az group create --name $rg --location $loc
az storage account create --name $stg --location $loc --resource-group $rg --sku Standard_LRS
az functionapp create `
  --resource-group $rg `
  --consumption-plan-location $loc `
  --runtime node --runtime-version 20 `
  --functions-version 4 `
  --name $app `
  --storage-account $stg
```

**2. Push the code**:

```powershell
npm run build
func azure functionapp publish $app
```

**3. Configure app settings** (must match the agent's `.env`):

```powershell
az functionapp config appsettings set --name $app --resource-group $rg --settings `
  AGENT_CALLBACK_URL='https://<your-agent-host>' `
  INTERNAL_TRIGGER_TOKEN='<random-secret>' `
  WEBSITE_TIME_ZONE='India Standard Time'
```

`WEBSITE_TIME_ZONE` is optional. Both cron expressions are UTC-anchored, so the schedule fires correctly regardless of `WEBSITE_TIME_ZONE`. Setting it just gives you nicer logs in the portal.

**4. Verify** — open the Function App in the portal → *Functions* → each timer → *Monitor* to see runs. Or CLI:

```powershell
az functionapp log tail --name $app --resource-group $rg
```

## Local sample settings

[`local.settings.sample.json`](local.settings.sample.json) is committed to source control; **`local.settings.json`** is gitignored (contains your dev-tunnel URL and shared secret). Copy the sample, edit, and never commit the local copy.

## Troubleshooting

- **Timer fires but the agent gets nothing** — verify the dev tunnel is public/anonymous or that its auth mode isn't blocking the POST. The internal endpoints validate the shared secret, not tunnel-level auth.
- **`invalid internal token` returned by the agent** — `INTERNAL_TRIGGER_TOKEN` mismatch between agent `.env` and Function app settings.
- **Nothing scheduled at expected times** — remember NCRONTAB in host.json is **UTC** unless `WEBSITE_TIME_ZONE` is set. `0 30 3 * * 1-5` = 03:30 UTC = 09:00 IST.
- **Function running but agent returns 500** — call `POST /api/internal/*` from your own shell first (see the agent's README) to isolate whether the failure is in the Function's HTTP call or the agent's downstream logic.

## Files

```
azure-functions/
├─ host.json                       Functions runtime config
├─ local.settings.sample.json      Template — copy to local.settings.json before `func start`
├─ package.json
├─ tsconfig.json
└─ src/
   └─ index.ts                     Both timer definitions (v4 programming model)
```

