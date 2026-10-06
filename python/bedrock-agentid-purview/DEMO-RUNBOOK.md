# Purview DLP + Sensitivity Labels on the Entra Agent ID / AWS Bedrock POC
## Step-by-step runbook (manual setup + demo talk track)

**What you are adding to `3P-Agent-ID-Demo-2/sidecar/llm-agent-aws`:** two Microsoft Purview capabilities, called over plain Microsoft Graph REST with the **delegated Agent Identity token (TR) the sidecar already produces**. No Purview SDK, no Agent Framework, no `azure-identity`, no new Python packages.

| Capability | What the audience sees | Who enforces it |
|---|---|---|
| **DLP on prompts and responses** | Credit card / SSN in a prompt → ⛔ blocked before Bedrock. Sensitive data in an answer → ⛔ blocked before the user | **Microsoft Purview** (policy owned by the compliance admin) |
| **Sensitivity-label-aware agent** | Agent reads a OneDrive document, shows its label, refuses *Highly Confidential* files, and the answer inherits the highest label of the documents used | Purview supplies labels + inheritance; **the agent honours them** |

Everything below assumes the POC already works in **OBO mode** (MSAL sign-in → Tc → sidecar OBO → TR → Weather API), exactly as in your screenshots.

---

## Part 0 — How it fits your architecture (say this on the first slide)

```
Browser (MSAL.js)  ──Tc──▶  Flask agent (llm-agent-aws)  ──Tc──▶  Sidecar  ──OBO──▶  Entra ID
                                     │                                 ◀──TR──┘
                                     │  TR: aud=graph.microsoft.com, idtyp=user, appid=<Agent Identity>
                                     │      scp = ... Content.Process.User ProtectionScopes.Compute.User
                                     │            SensitivityLabel.Read SensitivityLabel.Evaluate Files.Read.All Sites.Read.All
                                     │
        Gate 1  ───────────────────▶ │ POST /me/dataSecurityAndGovernance/protectionScopes/compute   (Purview)
        (prompt DLP)                 │ POST /me/dataSecurityAndGovernance/processContent  uploadText  (Purview)
                                     │
        Tools ─────────────────────▶ │ get_weather            → Weather API (unchanged)
                                     │ read_onedrive_document → GET /sites/{host}:/sites/PurviewDemo  (resolve site)
                                     │                          GET /sites/{site-id}/drive/root:/{file}
                                     │                          POST .../extractSensitivityLabels        (Purview)
                                     │                          label gate (PURVIEW_BLOCKED_LABEL_IDS)
                                     │ AWS Bedrock (Claude) — unchanged
                                     │
        Gate 3  ───────────────────▶ │ GET  .../sensitivityLabels/computeInheritance(...)                (Purview)
        (label + response DLP)       │ POST /me/dataSecurityAndGovernance/processContent  downloadText  (Purview)
                                     ▼
                              Answer + badges: Purview DLP verdicts · inherited label · sources
```

**Key message for the customer:** the same delegated Agent Identity token that authorises the Weather API call now also carries Purview's permissions. One identity, one token, governed end-to-end — and all of it under the *signed-in user's* identity (the demo user in your screenshots), which is why Purview policies apply per user.

**What did NOT change:** the sidecar image, the Weather API, the MSAL sign-in, the Autonomous flow, `requirements.txt`.

**One sidecar setting DID change:** `DownstreamApis__graph__RequestAppToken` is now `false` (it was `true` in the original compose file). With `true` the `/AuthorizationHeader/graph` OBO endpoint returns an *app-only* token (`idtyp=app`, `roles=[…]`), and Purview's `/me/...` APIs reject it with *"/me request is only valid with delegated authentication flow"*. With `false` it returns the delegated TR (`idtyp=user`, `scp=…`). The Autonomous flow uses `graph-app`, which keeps `RequestAppToken=true`.

---

## Part 1 — Collect what you need (15 min)

| Item | Where to get it | Example from your POC |
|---|---|---|
| `TENANT_ID` | `sidecar/.env` | — |
| `BLUEPRINT_APP_ID` | `sidecar/.env` (Blueprint app registration) | — |
| `AGENT_CLIENT_ID` | `sidecar/.env` (Agent Identity; equals the `appid`/`oid` in the TR token) | — |
| Demo user | The user who signs in via MSAL in OBO mode | <demo user> |
| Admin for Entra steps | Global Administrator (needed for tenant-wide delegated consent) + Agent ID Administrator | — |
| Admin for Purview steps | Compliance Administrator or Compliance Data Administrator | — |
| Licensing check | Ask the Purview admin to confirm **Purview pay-as-you-go billing is enabled** — protections for non-Microsoft AI apps are metered | — |
| Purview Audit | Must be **on** (Purview portal → Audit) | — |

Tooling on the admin machine (nothing is installed in the agent container):
- PowerShell 7 with `Microsoft.Graph` (already used by `EntraAgentID-Functions.ps1`) and `ExchangeOnlineManagement` (`Install-Module ExchangeOnlineManagement -Scope CurrentUser`).
- A browser for **Graph Explorer** (https://developer.microsoft.com/graph/graph-explorer) — used for all verification, no code required.

---

## Part 2 — Entra: give the Agent Identity the Purview permissions (20 min)

### Why this step is different from `Add-AgentIdentityPermissions`
Your existing function assigns **application roles** (`appRoleAssignments`, shows up in `roles` of T1 — e.g. `User.Read.All`). Purview's `/me/...` APIs need **delegated scopes** (the `scp` claim of the delegated TR token). Agent Identities cannot go through an interactive consent prompt (they return `AADSTS82014`), so an admin must **pre-authorise** the scopes: declare them on the Blueprint, make them inheritable, and grant tenant-wide consent.

### 2.1 Run the script
```powershell
cd tenant-setup
.\1-Grant-PurviewPermissions.ps1 -TenantId <TENANT_ID> -BlueprintAppId <BLUEPRINT_APP_ID> -AgentIdentityId <AGENT_CLIENT_ID>
```
The script performs, in order (all on Graph v1.0):

| # | Action | API |
|---|---|---|
| A | Declare the 5 delegated scopes on the Blueprint | `PATCH /applications/{blueprintObjectId}` → `requiredResourceAccess` |
| B | Make Graph scopes inheritable by every Agent Identity created from the Blueprint | `POST /applications/{id}/microsoft.graph.agentIdentityBlueprint/inheritablePermissions` with `inheritableScopes = allAllowedScopes` (needs `AgentIdentityBlueprint.ReadWrite.All`; caller = Blueprint owner or Agent ID Administrator) |
| C | Tenant-wide admin consent on the Blueprint principal **and** on the Agent Identity | `POST /oauth2PermissionGrants` `{ clientId, consentType: "AllPrincipals", resourceId: <Graph SP>, scope: "..." }` |

Scopes granted: `ProtectionScopes.Compute.User Content.Process.User SensitivityLabel.Read SensitivityLabel.Evaluate Files.Read.All Sites.Read.All` (plus the existing `openid profile email User.Read`).

### 2.2 Do it manually instead (if you prefer clicking, or to show the customer where it lives)
1. **Entra admin center → App registrations → your Blueprint → API permissions → Add a permission → Microsoft Graph → Delegated permissions.** Search and tick: `ProtectionScopes.Compute.User`, `Content.Process.User`, `SensitivityLabel.Read`, `SensitivityLabel.Evaluate`, `Files.Read.All`, `Sites.Read.All`. Click **Add permissions**, then **Grant admin consent for <tenant>**. (This is step A + consent on the Blueprint.)
2. **Inheritable permissions** have no portal UI yet — in **Graph Explorer** (signed in as the admin who owns the Blueprint, or an Agent ID Administrator), consent to `AgentIdentityBlueprint.ReadWrite.All`, then
   `POST https://graph.microsoft.com/v1.0/applications/<BLUEPRINT_APP_ID>/microsoft.graph.agentIdentityBlueprint/inheritablePermissions`, body:
   ```json
   { "resourceAppId": "00000003-0000-0000-c000-000000000000",
     "inheritableScopes": { "@odata.type": "microsoft.graph.allAllowedScopes" } }
   ```
   Expect `201`. A `409` means it already exists — use `PATCH .../inheritablePermissions/00000003-0000-0000-c000-000000000000` with the same body instead. (For Blueprints the object id equals the app id.)
3. **Consent directly on the Agent Identity** (belt and braces — the OBO token is issued to the Agent Identity as the client): Graph Explorer → `POST https://graph.microsoft.com/v1.0/oauth2PermissionGrants`
   ```json
   { "clientId": "<AGENT_CLIENT_ID>", "consentType": "AllPrincipals",
     "resourceId": "<object id of the Microsoft Graph service principal>",
     "scope": "openid profile email User.Read ProtectionScopes.Compute.User Content.Process.User SensitivityLabel.Read SensitivityLabel.Evaluate Files.Read.All Sites.Read.All" }
   ```
   Get the Graph SP id with `GET /v1.0/servicePrincipals?$filter=appId eq '00000003-0000-0000-c000-000000000000'`. If a grant already exists for that client/resource pair, `PATCH /oauth2PermissionGrants/{id}` with the merged `scope` string.

### 2.3 Verify — the token card is your proof
1. **Restart the sidecar** so it drops cached tokens: `docker compose -f docker-compose-aws.yml restart sidecar` (Container Apps: restart the sidecar revision).
2. Open the demo UI → **OBO** → **Sign in** as the demo user → ask *"What's the weather in Dallas?"*.
3. In the debug panel, expand **OBO 2.D TOKEN RECEIVED → TR**. The `scp` row must now read
   `openid profile email User.Read ProtectionScopes.Compute.User Content.Process.User SensitivityLabel.Read SensitivityLabel.Evaluate Files.Read.All Sites.Read.All` (order may vary).
   If it still shows only `openid profile User.Read email`: wait 2–3 minutes (consent propagation), restart the sidecar again, and re-check the grant on the Agent Identity (`GET /v1.0/oauth2PermissionGrants?$filter=clientId eq '<AGENT_CLIENT_ID>'`).

---

## Part 3 — Purview: sensitivity labels (20 min, once)

### 3.1 Labels and label policy
Purview portal → **Information Protection → Sensitivity labels**.
1. Make sure you have (or create) two labels published to the demo user:
   - **Confidential** — scope *Files & other data assets*; **no encryption** (so the agent can read the content and you can show the label travelling with the answer).
   - **Highly Confidential** — scope *Files & other data assets*; encryption optional (see the note in Scene 4).
2. **Publish** them via a label policy that includes the demo user (Information Protection → Label policies). New/changed policies take up to 24 h to reach Office clients — do this the day before.
3. **SharePoint label integration** must be on, otherwise `extractSensitivityLabels` returns nothing. In SharePoint Online Management Shell: `Set-SPOTenant -EnableAIPIntegration $true` (one-time, tenant-wide; many tenants already have it).

### 3.2 Get the label GUIDs (you need the *Highly Confidential* one for `PURVIEW_BLOCKED_LABEL_IDS`)
Either:
- **Graph Explorer**, signed in as the demo user, consent to `SensitivityLabel.Read` (Modify permissions tab), then
  `GET https://graph.microsoft.com/v1.0/security/dataSecurityAndGovernance/sensitivityLabels` → copy `id` and note `name`, `color`, `priority` for each label (sub-labels are under `sublabels`).
- or Security & Compliance PowerShell: `Connect-IPPSSession; Get-Label | Format-Table DisplayName, ImmutableId` — `ImmutableId` is the GUID.

Write them down:

| Label | GUID |
|---|---|
| Confidential | `________________________________` |
| Highly Confidential | `________________________________` → goes into `PURVIEW_BLOCKED_LABEL_IDS` |

---

## Part 4 — Purview: the DLP policy (15 min + up to 1 h sync)

The Purview portal cannot scope a DLP policy to an Entra app yet — it must be done in Security & Compliance PowerShell with the **Application** enforcement plane.

### 4.1 Run the script
```powershell
cd tenant-setup
.\2-Create-PurviewDlpPolicy.ps1 -AgentIdentityId <AGENT_CLIENT_ID> -BlueprintAppId <BLUEPRINT_APP_ID> -AlertRecipient <admin UPN> `
    -EnableDspmCollectionPolicy -DspmScopeGroupId <object id of an Entra group that contains the demo user>
```
What it creates:

| Object | Settings |
|---|---|
| Policy `Agent ID Demo - Block sensitive data in AI agent` | `-EnforcementPlanes @("Application")`, `-Mode Enable`, Locations = **both** the Agent Identity and the Blueprint app IDs (so the policy matches whichever app ID Purview keys on) |
| Rule `Block credit cards and SSNs in agent prompts and responses` | `ContentContainsSensitiveInformation` = Credit Card Number, U.S. SSN (minCount 1); `RestrictAccess` = `UploadText: Block`, `DownloadText: Block`; alert + incident report (High) + user notification |
| *(optional)* DSPM for AI collection policy | `New-FeatureConfiguration -FeatureScenario KnowYourData` for `UploadText/DownloadText` on the Application plane, scoped to an Entra group containing the demo user → interactions appear in **DSPM for AI → Activity explorer** |

### 4.2 Manual equivalent (for the slide, not for typing live)
```powershell
Connect-IPPSSession
$loc = @(@{Workload="Applications";Location="<AGENT_CLIENT_ID>";LocationDisplayName="Agent ID Weather Agent";LocationSource="Entra";LocationType="Individual";Inclusions=@(@{Type="Tenant";Identity="All"})}) | ConvertTo-Json -Depth 6 -Compress
New-DlpCompliancePolicy -Name "Agent ID Demo - Block sensitive data in AI agent" -Locations $loc -EnforcementPlanes @("Application") -Mode Enable
New-DlpComplianceRule -Name "Block credit cards and SSNs in agent prompts and responses" -Policy "Agent ID Demo - Block sensitive data in AI agent" `
  -ContentContainsSensitiveInformation @(@{Name="Credit Card Number";minCount="1"},@{Name="U.S. Social Security Number (SSN)";minCount="1"}) `
  -RestrictAccess @(@{Setting="UploadText";Value="Block"},@{Setting="DownloadText";Value="Block"}) `
  -GenerateAlert "SiteAdmin" -GenerateIncidentReport "SiteAdmin" -ReportSeverityLevel High -StopPolicyProcessing $true
```
Check it in the portal afterwards: **Purview → Data loss prevention → Policies** — the policy is listed (location shows as an application).

### 4.3 Verify with Graph Explorer BEFORE touching the agent (10 min — do this the day before)
Sign in to Graph Explorer as the **demo user**. Consent (Modify permissions) to `ProtectionScopes.Compute.User` and `Content.Process.User`.

**a) Protection scopes**
`POST https://graph.microsoft.com/v1.0/me/dataSecurityAndGovernance/protectionScopes/compute`
```json
{ "activities": "uploadText,downloadText",
  "locations": [ { "@odata.type": "microsoft.graph.policyLocationApplication", "value": "<AGENT_CLIENT_ID>" } ] }
```
Expected: `value` contains an entry with `"activities": "uploadText,downloadText"` (or two entries), `"executionMode": "evaluateInline"`. **Empty `value` = policy not distributed yet or wrong location ID** — wait / check.

**b) Process content — the block**
`POST https://graph.microsoft.com/beta/me/dataSecurityAndGovernance/processContent`
```json
{ "contentToProcess": {
    "contentEntries": [ { "@odata.type": "microsoft.graph.processConversationMetadata",
        "identifier": "11111111-1111-1111-1111-111111111111",
        "content": { "@odata.type": "microsoft.graph.textContent", "data": "Please reimburse card 4532-1234-5678-9010 for my Dallas trip" },
        "name": "preflight", "correlationId": "22222222-2222-2222-2222-222222222222", "sequenceNumber": 0, "isTruncated": false,
        "createdDateTime": "2026-09-10T12:00:00Z", "modifiedDateTime": "2026-09-10T12:00:00Z" } ],
    "activityMetadata": { "activity": "uploadText" },
    "deviceMetadata": { "operatingSystemSpecifications": { "operatingSystemPlatform": "Windows", "operatingSystemVersion": "11" } },
    "protectedAppMetadata": { "name": "Agent ID Weather Agent (Bedrock)", "version": "1.0",
        "applicationLocation": { "@odata.type": "microsoft.graph.policyLocationApplication", "value": "<AGENT_CLIENT_ID>" } },
    "integratedAppMetadata": { "name": "Agent ID Weather Agent (Bedrock)", "version": "1.0" } } }
```
Expected: `"policyActions": [ { "action": "restrictAccess", "restrictionAction": "block" } ]`. Replace the card number with *"What's the weather in Dallas?"* → `"policyActions": []`.
If the card number comes back with an empty `policyActions`: the policy is in Test mode, not yet distributed, or the location ID differs → fix before the demo.

**c) Labels**
`GET https://graph.microsoft.com/v1.0/sites/<tenant>.sharepoint.com:/sites/PurviewDemo` → copy `id` (the site id), then
`POST https://graph.microsoft.com/v1.0/sites/<site id>/drive/root:/Weather-Ops-Playbook.docx:/extractSensitivityLabels` (after Part 5) → `value.labels[0].sensitivityLabelId` = the *Confidential* GUID.
`GET https://graph.microsoft.com/v1.0/security/dataSecurityAndGovernance/sensitivityLabels/computeInheritance(labelIds=["<Confidential GUID>"],locale='en-US',contentFormats=["File"])` → returns the Confidential label object.

When a), b) and c) behave, the tenant is ready — independent of AWS.

---

## Part 5 — Demo documents in a SharePoint site (20 min)

1. **Create the site.** https://<tenant>.sharepoint.com → **+ Create site → Team site** → name **`PurviewDemo`** (site address `/sites/PurviewDemo`) → privacy *Private* → **Next** → add **the demo user** as a member (owner is fine) → **Finish**. (A SharePoint admin can also create it from the SharePoint admin center → Sites → Active sites → Create.)
2. **Create the documents.** Sign in as **the demo user**, open the site → **Documents** library → **+ New → Word document**, paste the text, apply the label (**File → Info → Sensitivity**, or the *Sensitivity* button on the Home ribbon), rename via the title box. File names must have **no spaces** — the agent parses the name from the chat message.

| File name (exact) | Label | Content (paste) | Used in |
|---|---|---|---|
| `Weather-Ops-Playbook.docx` | **Confidential** | *Contoso Field Operations — Severe Weather Playbook. 1) Escalate to the regional duty manager when sustained winds exceed 40 mph or a tornado watch is issued. 2) Suspend rooftop work at any lightning alert within 10 miles. 3) Notify customers of service delays via the outage portal within 30 minutes. 4) The Dallas and Houston depots hold 72 hours of generator fuel.* | Scene 3 — read, label shown, answer inherits *Confidential* |
| `Vendor-Contract.docx` | **Highly Confidential** | *Master Services Agreement between Contoso Ltd and Northwind Weather Data Inc. Annual fee USD 480,000. Termination for convenience with 90 days' notice. Liability cap 12 months of fees.* | Scene 4 — label gate refuses to send it to Bedrock |
| `Customer-Refunds.docx` | **Confidential** | *Refund queue — storm week. Ticket 1042: Alex Wilber, card 4532 0151 1283 0366, refund USD 120 approved. Ticket 1043: Megan Bowen, card 4916 7318 3432 4545, pending.* (test numbers only) | Scene 5 — label allows reading, **DLP blocks the response** |

3. **Optional "no access" scene.** Create a second private site (e.g. `BoardOnly`) that the demo user is **not** a member of, with any document. Asking the agent for it returns *Access denied* — the agent has exactly the demo user's permissions, no more. To use it, point `PURVIEW_SITE_URL` at it temporarily, or simply ask for a file name that doesn't exist in `PurviewDemo` (404 gives the same message).
4. Wait a minute after saving, then run check 4.3 c) to confirm the labels are readable through Graph.

---

## Part 6 — Deploy the patched agent (15 min)

Files in this package (`sidecar/`):

| File | Change |
|---|---|
| `llm-agent-aws/purview_rest.py` | **new** — Purview + label calls over Graph REST (`requests` + stdlib only) |
| `llm-agent-aws/app.py` | patched — see `app.py.diff` (≈300 added lines, 8 changed). Adds: `read_onedrive_document` tool, Gate 1 / Gate 3 in `/api/chat`, `PURVIEW …` debug steps, badges in the UI |
| `docker-compose-aws.yml` | adds the `PURVIEW_*`, `BLUEPRINT_APP_ID`, `TENANT_ID` env vars to `llm-agent-aws` |
| `.env.example` | documents the new variables |
| `llm-agent-aws/requirements.txt` | **unchanged** — nothing new to mirror into Artifactory |

### 6.1 Copy the files
Copy `purview_rest.py` and the patched `app.py` into your `sidecar/llm-agent-aws/`, and replace `docker-compose-aws.yml`. (Or apply `app.py.diff` with `git apply` if the customer prefers to review a diff.)

### 6.2 Set the environment (`sidecar/.env`)
```env
PURVIEW_ENABLED=true
PURVIEW_APP_NAME=Agent ID Weather Agent (Bedrock)
PURVIEW_LOCATION_APP_ID=            # empty = AGENT_CLIENT_ID
PURVIEW_ALWAYS_EVALUATE=true
PURVIEW_FAIL_CLOSED=true
PURVIEW_BLOCKED_LABEL_IDS=<Highly Confidential GUID>
PURVIEW_SITE_URL=https://<tenant>.sharepoint.com/sites/PurviewDemo
```

### 6.3 Rebuild and start
Local Docker:
```bash
cd sidecar
docker compose -f docker-compose-aws.yml up -d --build llm-agent-aws
docker compose -f docker-compose-aws.yml restart sidecar
docker compose -f docker-compose-aws.yml logs -f llm-agent-aws
```
Azure Container Apps (your screenshots show this deployment): rebuild and push the `llm-agent-aws` image as you do today, then
```bash
az containerapp update -n <llm-agent-aws app> -g <resource group> --image <registry>/<image>:<tag> \
  --set-env-vars PURVIEW_ENABLED=true "PURVIEW_APP_NAME=Agent ID Weather Agent (Bedrock)" PURVIEW_ALWAYS_EVALUATE=true \
                 PURVIEW_FAIL_CLOSED=true PURVIEW_BLOCKED_LABEL_IDS=<Highly Confidential GUID> \
                 PURVIEW_SITE_URL=https://<tenant>.sharepoint.com/sites/PurviewDemo BLUEPRINT_APP_ID=<id> TENANT_ID=<id>
az containerapp revision restart -n <sidecar app> -g <resource group> --revision <active revision>
```
Network: the agent container now also calls `https://graph.microsoft.com` directly (the token exchange still goes through the sidecar). Allow that egress if the environment is locked down.

### 6.4 Smoke test
`GET http://localhost:3001/api/status` → shows `"purview_enabled": true`, `"purview_location_app_id"`, `"purview_blocked_label_ids"`, `"purview_site_url"`.

---

## Part 7 — Pre-flight checklist (10 minutes before the customer joins)

- [ ] Sidecar restarted after consent; **TR token card shows the five Purview scopes in `scp`**
- [ ] Graph Explorer check 4.3 b) returns `restrictAccess / block` for the card number
- [ ] The three documents exist in the `PurviewDemo` site's Documents library with the right labels (check 4.3 c)); the demo user is a member of the site
- [ ] `PURVIEW_BLOCKED_LABEL_IDS` holds the *Highly Confidential* GUID (`/api/status`)
- [ ] Demo user signed in (OBO), **Direct** mode selected for scenes 1–2 and 5 (fast, deterministic), **Bedrock** for scenes 3–4
- [ ] Purview portal open in a second tab: **Data loss prevention → Alerts** and **DSPM for AI → Activity explorer**
- [ ] AWS Bedrock reachable (`/api/status` → `bedrock_available: true`); remember the app enforces a 20 s gap between Bedrock calls

---

## Part 8 — Demo script (≈15 minutes)

Layout: chat on the left, debug panel on the right. Keep the token card visible — it is the bridge between the Agent ID story the customer already knows and the Purview story you are adding.

### Scene 1 — "Same agent, now governed" (Direct + OBO)
**Type:** `What's the weather in Dallas?`
**Show:**
- `OBO 2.D TOKEN RECEIVED` → TR card: `aud = https://graph.microsoft.com`, `idtyp = user`, `name = <demo user>`, and **`scp` now includes `Content.Process.User`, `ProtectionScopes.Compute.User`, `SensitivityLabel.*`, `Files.Read.All`**.
- `🛡️ PURVIEW 1.A PROTECTION SCOPES` — Purview says which activities to evaluate for *this user and this app* (`uploadText, downloadText`).
- `🛡️ PURVIEW 1.B PROMPT DLP → ALLOWED` — the prompt was evaluated *before* the tool/LLM ran.
- `🛡️ PURVIEW 3.A RESPONSE DLP → ALLOWED` — the answer was evaluated *before* it reached the user.
- Under the answer: **Purview DLP · prompt ✅ ALLOWED · response ✅ ALLOWED**.
**Say:** "Nothing about the identity flow changed. The delegated Agent Identity token now also carries Purview permissions, so every prompt and every answer is checked under the signed-in user's identity. Two Graph calls, no SDK in the container."

### Scene 2 — DLP blocks a prompt (Direct + OBO)
**Type:** `My card 4532-1234-5678-9010 was charged twice in Dallas — what was the weather that day?`
**Show:**
- `⛔ PURVIEW 1.B PROMPT DLP → BLOCKED` with `policy_actions: restrictAccess / block` and a `client_request_id`.
- `5. COMPLETE — Stopped by Purview DLP — nothing was sent to AWS Bedrock`. No `TOOL CALLED`, no `API CALL`.
- Red answer: *"Your request was blocked by a Microsoft Purview DLP policy…"*; badge **prompt ⛔ BLOCKED**.
**Say:** "The block decision came from Purview, from a policy the compliance team owns — the developer didn't write a regex. The credit card never left the customer's boundary towards Bedrock. Note the Client-Request-Id: that's what we hand to Microsoft support if we ever need to trace an evaluation."

### Scene 3 — Label-aware reading + inheritance (Bedrock + OBO)
Switch LLM mode to **Bedrock**.
**Type:** `Summarize Weather-Ops-Playbook.docx`
**Show:**
- `1. TOOL CALLED — Document function called…` (Claude chose the document tool) → `2. DOCUMENT SOURCE — SharePoint site resolved: PurviewDemo` (Graph resolved the site under the user's identity).
- `🛡️ PURVIEW LABEL 2.A FILE LABEL — Weather-Ops-Playbook.docx → Confidential` (via `extractSensitivityLabels`, with the user's own delegated access).
- `🛡️ PURVIEW LABEL 2.B LABEL GATE → ALLOWED`, then `4. TOOL RESULT` with the text preview.
- `🛡️ PURVIEW LABEL 2.C INHERITANCE — The answer inherits the sensitivity label: Confidential` (via `computeInheritance`).
- `🛡️ PURVIEW 3.A RESPONSE DLP → ALLOWED`.
- Under the answer: **🏷️ Sensitivity label (inherited): Confidential** (in the label's real colour) and **📄 Sources: Weather-Ops-Playbook.docx [Confidential]**.
**Say:** "The agent only sees what the demo user can open — that's the delegated flow. Purview tells us the file's label, and Purview computes what label the *answer* should carry. This is how Copilot-style label inheritance is built, and it needed zero packages."

### Scene 4 — Label gate refuses a Highly Confidential file (Bedrock + OBO)
**Type:** `What are the payment terms in Vendor-Contract.docx?`
**Show:**
- `🛡️ PURVIEW LABEL 2.A FILE LABEL — Vendor-Contract.docx → Highly Confidential`.
- `⛔ PURVIEW LABEL 2.B LABEL GATE → BLOCKED — … not sent to Bedrock`.
- Claude's answer says the document is restricted by its sensitivity label; badge **⛔ a document was withheld by its sensitivity label**; no `TOOL RESULT` preview, no content downloaded.
**Say (be precise here):** "This gate is enforced by the agent using Purview's label metadata — Purview supplies the truth, the agent honours it. The DLP block in scene 2 was Purview's own decision. Both matter, and they're distinct." If your *Highly Confidential* label applies encryption, also mention: "and even if the gate weren't there, the download is an encrypted blob the container can't read — the panel shows `PURVIEW LABEL 2.B ENCRYPTED` in that case."

### Scene 5 — DLP blocks a *response* (Direct + OBO)
Switch back to **Direct** (deterministic — the raw document text becomes the answer).
**Type:** `Show me Customer-Refunds.docx`
**Show:**
- `PURVIEW LABEL 2.A FILE LABEL → Confidential`, `LABEL GATE → ALLOWED` (label permits reading).
- `⛔ PURVIEW 3.A RESPONSE DLP → BLOCKED` — the text contains credit card numbers.
- Red answer: *"The response was blocked by a Microsoft Purview DLP policy…"*; badge **prompt ✅ ALLOWED · response ⛔ BLOCKED**, label badge still **Confidential**.
**Say:** "Labels and DLP work together: the label said the agent *may* read the file; DLP said the content *may not* be shown. Same policy, applied on the way out."

### Scene 5b (optional) — A file the demo user cannot see
**Type:** `Read Board-Minutes.docx` (a file that is not in the PurviewDemo library, or lives in a site the demo user isn't a member of).
**Show:** `3. ACCESS DENIED / NOT FOUND — HTTP 404/403 … the agent has exactly the signed-in user's permissions, no more`.
**Say:** "Three layers, in order: SharePoint permissions decide what the agent can even see; the sensitivity label decides what it may process; DLP decides what may flow. All three are the user's, not the agent's."

### Scene 6 — Why OBO matters (Autonomous)
Switch Token Flow to **Autonomous**, ask for the weather.
**Show:** `🛡️ PURVIEW SKIPPED — Purview DLP is evaluated per signed-in user — switch Token Flow to OBO to see it`; the answer footer says *Purview: not evaluated*.
**Say:** "Purview policies are user-centric. That's the architectural reason to run the agent on-behalf-of the user — and it's why Entra Agent ID's OBO flow and Purview belong together."

### Scene 7 — Prove it in Purview (portal tab)
- **Data loss prevention → Alerts**: a new alert for the policy from scene 2/5 (alerts typically appear within minutes; can take longer).
- **Incident report e-mail** to the recipient configured in the script.
- **DSPM for AI → Activity explorer** (if the collection policy was enabled): the interactions for the app, attributed to the demo user, with the sensitive info types detected.
- **Audit** (search by the demo user / time window) for the raw records.
**Say:** "Nothing the agent did is invisible to the compliance team."

---

## Part 9 — What to answer when the customer asks…

| Question | Answer |
|---|---|
| "Did you install anything new?" | No. `requirements.txt` is unchanged; `purview_rest.py` uses `requests` (already there) and the standard library. |
| "Can the agent reach a SharePoint site the user can't?" | No. Everything is delegated (OBO): the site resolves and files open only if the signed-in user has access — the demo shows the 403/404. |
| "Which identity calls Purview?" | The Agent Identity, acting on behalf of the signed-in user (TR: `appid` = agent, `idtyp = user`). Purview records the user and, via `agents[].identifier / blueprintId` in the request, the Agent ID. |
| "Where is the DLP policy defined?" | In Purview, by the compliance admin, scoped to the agent's Entra app IDs. The developer never sees the rules. |
| "Is the label refusal a Purview feature?" | It is the agent honouring Purview's label metadata (`extractSensitivityLabels` + `computeInheritance` are Purview APIs). The DLP block is Purview's own decision. |
| "Can Purview block based on the label instead?" | The DLP rule for the Application location is sensitive-info-type based in this POC; label-based conditions on this path were not tested — don't promise it. |
| "What about the autonomous agent?" | Purview's `/me` APIs are user-centric. For an autonomous agent you'd evaluate under `/users/{id}` with application permissions and a designated owner identity — a phase-2 conversation. |
| "Is this GA?" | `protectionScopes/compute` and all label APIs are Graph **v1.0**. `processContent` is Graph **beta** today — position the DLP part as preview. |
| "What would the SDK have given us?" | Response caching and the ETag refresh loop. Both are ~20 lines here (`etag` / `protectionScopeState` are already handled). |

---

## Part 10 — Troubleshooting

| Symptom (debug panel) | Cause | Fix |
|---|---|---|
| `PURVIEW ERROR … HTTP 400` *"/me request is only valid with delegated authentication flow"*; TR card shows `idtyp: app` | Sidecar minted an app-only token for the OBO path | Set `DownstreamApis__graph__RequestAppToken=false` in the compose file; `docker compose … up -d --force-recreate sidecar`; sign out/in |
| `PURVIEW ERROR … HTTP 403` on `protectionScopes/compute` | Agent Identity has no consent for `ProtectionScopes.Compute.User` / `Content.Process.User` | Re-run script 1 (or the manual grants in 2.2); restart the sidecar; confirm `scp` in the TR card |
| TR `scp` still `openid profile User.Read email` after consent | Sidecar token cache / propagation | Restart the sidecar container; wait 2–3 min; check `GET /v1.0/oauth2PermissionGrants?$filter=clientId eq '<AGENT_CLIENT_ID>'` |
| `PURVIEW 1.A … Activities: none` | Policy not distributed yet (up to 1 h) or location ID ≠ the ID in the DLP policy | Wait; verify `Get-DlpCompliancePolicy … | fl Locations`; set `PURVIEW_LOCATION_APP_ID` to the Blueprint ID if that's what the policy contains |
| Card number → `PROMPT DLP → ALLOWED` | Policy in Test mode, still syncing, or wrong location | Check `Mode = Enable`; re-run Graph Explorer 4.3 b) |
| `PURVIEW NOTE — optional metadata rejected … retrying` | Beta API rejected `agents` / `accessedResources_v2` | Harmless — the agent retries with the minimal payload automatically |
| `3. ACCESS DENIED / NOT FOUND` (404) | Wrong file name, spaces in the name, or file in a different library | Use the exact name (`Vendor-Contract.docx`), no spaces; path is relative to the site's *Documents* library |
| `3. ACCESS DENIED / NOT FOUND` (403) or `2. DOCUMENT SOURCE` fails | The demo user is not a member of the site, or `Sites.Read.All` not consented | Add the user to the site; confirm `Sites.Read.All` in the TR `scp` |
| `FILE LABEL → no sensitivity label` | Label not applied/saved, or SPO label integration off | Re-apply in Word and save; `Set-SPOTenant -EnableAIPIntegration $true`; wait a minute |
| `PURVIEW LABEL 2.B ENCRYPTED` | Label applies encryption | Expected — use it as a talking point, or pick a label without encryption for the readable file |
| `Request timed out` in Bedrock mode | 20 s rate-limit guard in `app.py` + Bedrock latency | Use Direct mode for scenes 1, 2, 5; wait 20 s between Bedrock prompts |
| Purview alert not visible yet | Alert pipeline latency | Show the incident e-mail or Activity explorer; check again at the end of the session |

---

## Appendix A — Environment variables (llm-agent-aws)

| Variable | Default | Purpose |
|---|---|---|
| `PURVIEW_ENABLED` | `true` | Master switch for both gates |
| `PURVIEW_APP_NAME` | `Agent ID Weather Agent (Bedrock)` | Name Purview records for the app |
| `PURVIEW_LOCATION_APP_ID` | `AGENT_CLIENT_ID` | Entra app ID matching the DLP policy location |
| `PURVIEW_ALWAYS_EVALUATE` | `true` | Call `processContent` even when compute returns no scope (keeps the demo visible) |
| `PURVIEW_FAIL_CLOSED` | `true` | Block the request if Purview returns an error (shows the `Client-Request-Id`) |
| `PURVIEW_BLOCKED_LABEL_IDS` | *(empty)* | Comma-separated label GUIDs the agent refuses to send to the LLM |
| `PURVIEW_SITE_URL` | *(empty = OneDrive)* | SharePoint site whose *Documents* library holds the demo files, e.g. `https://<tenant>.sharepoint.com/sites/PurviewDemo` |

## Appendix B — Graph calls used (all with the delegated TR token)

| Purpose | Call | Version | Scope |
|---|---|---|---|
| Which activities to evaluate | `POST /me/dataSecurityAndGovernance/protectionScopes/compute` | v1.0 | `ProtectionScopes.Compute.User` |
| DLP on prompt / response | `POST /me/dataSecurityAndGovernance/processContent` (`uploadText` / `downloadText`) | beta | `Content.Process.User` |
| Label catalogue (names, colours) | `GET /security/dataSecurityAndGovernance/sensitivityLabels` | v1.0 | `SensitivityLabel.Read` |
| Resolve the SharePoint site | `GET /sites/{hostname}:/sites/PurviewDemo` | v1.0 | `Sites.Read.All` |
| Label on a file | `POST /sites/{site-id}/drive/root:/{file}:/extractSensitivityLabels` | v1.0 | `Files.Read.All` |
| Label the answer inherits | `GET /security/dataSecurityAndGovernance/sensitivityLabels/computeInheritance(labelIds=[…],locale='en-US',contentFormats=["File"])` | v1.0 | `SensitivityLabel.Evaluate` |
| File metadata + download | `GET /sites/{site-id}/drive/root:/{file}` | v1.0 | `Files.Read.All` |

## Appendix C — Debug-panel step names added

`PURVIEW 1.A PROTECTION SCOPES` · `PURVIEW 1.B PROMPT DLP → ALLOWED|BLOCKED|SKIPPED` · `2. DOCUMENT SOURCE` · `3. ACCESS DENIED / NOT FOUND` · `PURVIEW LABEL 2.A FILE LABEL` · `PURVIEW LABEL 2.B LABEL GATE → ALLOWED|BLOCKED` · `PURVIEW LABEL 2.B ENCRYPTED` · `PURVIEW LABEL 2.C INHERITANCE` · `PURVIEW 3.A RESPONSE DLP → ALLOWED|BLOCKED|SKIPPED` · `PURVIEW SKIPPED` · `PURVIEW NOTE` · `PURVIEW ERROR`
