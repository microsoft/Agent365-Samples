# Scrum Master Assistant — Azure Functions

Two timer-triggered functions that drive the SMA scheduled ceremonies. The agent process (in [`..`](..) — the parent `scenarios/scrum-master/` folder) owns all state, tokens, and Adaptive Card logic — these functions only *nudge* it via HTTP.

| Function | NCRONTAB | Local time | Calls |
|---|---|---|---|
| **StandupTimer** | `0 30 3 * * 1-5` (UTC) | 09:00 Asia/Kolkata, Mon–Fri | `POST {AGENT_CALLBACK_URL}/api/internal/standup-trigger` |
| **NightlyTimer** | `0 0 19 * * *` (UTC) | 00:30 Asia/Kolkata, daily | `POST {AGENT_CALLBACK_URL}/api/internal/nightly-check` (Warn, mid-sprint summary, sprint-close checks) |

## Design in one paragraph

The agent runs Express on `:3978` behind a dev tunnel (dev) or App Service / Container Apps (prod). It exposes three internal endpoints guarded by an `x-internal-token` header when a token is configured; these timers call the standup and nightly endpoints. Each Function timer wakes on schedule, POSTs to its endpoint, and passes the token through. The nightly route runs Warn, sprint-close and mid-sprint summary logic, each subject to its eligibility gate. The agent does the actual work (Jira REST, SharePoint writes, Adaptive Card sends).

- Both schedulers evaluate these expressions in **UTC**, independently of the agent's `TIMEZONE`. Use **one scheduler only**: daily standup deduplication is in-memory per agent process, not restart-safe or cross-process safe.
- **Local dev** typically uses `LOCAL_CRON=true` alone and never deploys these functions.
- **Production** sets `LOCAL_CRON=false`, `NODE_ENV=production`, `HOST=0.0.0.0` and a nonempty `INTERNAL_TRIGGER_TOKEN` in the agent host's application settings. Do not copy local development `.env` settings into Azure.

## Prerequisites

- Node.js 18.x or higher
- [Azure Functions Core Tools v4](https://aka.ms/azfunc-install) — `func --version` should print `4.x.x`.
- Azure CLI — `az --version`.
- An Azure subscription + resource group.
- The agent already running somewhere reachable — either a dev tunnel URL, App Service, or Container Apps endpoint that exposes `/api/internal/*` from [`..`](..) (the parent `scenarios/scrum-master/` folder).

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

**3. Configure app settings** (token must match the agent host's configured secret):

```powershell
az functionapp config appsettings set --name $app --resource-group $rg --settings `
  AGENT_CALLBACK_URL='https://<your-agent-host>' `
  INTERNAL_TRIGGER_TOKEN='<random-secret>'
```

Leave `WEBSITE_TIME_ZONE` **unset**. Where supported, setting it changes how Functions evaluates timer expressions, not merely log rendering. The expressions in [`src/index.ts`](src/index.ts) assume UTC: 03:30 UTC is 09:00 Asia/Kolkata; 19:00 UTC is 00:30 Asia/Kolkata on the following local day.

The Functions module fails startup if `WEBSITE_TIME_ZONE` is a non-UTC value
(only unset, `UTC` or `Etc/UTC` are accepted). Prefer leaving it unset.
Both timers retry a failed invocation up to three times with a fixed
30-second delay. A successful HTTP response does not itself prove a ceremony
was delivered: inspect the response/logs and the agent's delivery records.
The nightly endpoint returns HTTP 500 with `ok: false` if any check throws,
so those failures engage this retry policy. Previously successful checks
are not rolled back: unlike sprint close, the T-2 summary has no durable
delivery guard and can be posted again on retry.

**4. Verify** — open the Function App in the portal → *Functions* → each timer → *Monitor* to see runs. Or CLI:

```powershell
az functionapp log tail --name $app --resource-group $rg
```

## Local sample settings

[`local.settings.sample.json`](local.settings.sample.json) is committed to source control; **`local.settings.json`** is gitignored (contains your dev-tunnel URL and shared secret). Copy the sample, edit, and never commit the local copy.

## Troubleshooting

- **Timer fires but the agent gets nothing** — verify the dev tunnel is public/anonymous or that its auth mode isn't blocking the POST. The internal endpoints validate the shared secret, not tunnel-level auth.
- **`invalid internal token` returned by the agent** — `INTERNAL_TRIGGER_TOKEN` mismatch between agent `.env` and Function app settings.
- **Nothing scheduled at expected times** — schedules are declared in `src/index.ts`, not `host.json`. Verify `WEBSITE_TIME_ZONE` is absent and inspect the next timer occurrences. `0 30 3 * * 1-5` = 03:30 UTC = 09:00 IST weekdays.
- **Function running but agent returns 500** — call `POST /api/internal/*` from your own shell first (see the agent's README) to isolate whether the failure is in the Function's HTTP call or the agent's downstream logic.
- **Repeated timer retries do not post a report** — inspect `SMA_SprintReportsDelivery`. A `claimed` record can represent an uncertain delivery and deliberately blocks automatic duplicate sends. Follow the [claim recovery guidance](../README.md#claim-recovery) before changing its state; do not delete it just to make a retry run.

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
