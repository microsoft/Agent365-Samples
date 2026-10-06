# Microsoft Purview for an Entra Agent ID agent on AWS Bedrock (no SDK)

Adds Microsoft Purview data loss prevention (DLP) and sensitivity-label handling to the
`llm-agent-aws` agent of the 3P-Agent-ID-Demo sample **without installing the Purview SDK
or any new Python package**. The agent calls Purview's Microsoft Graph REST endpoints directly
with the delegated Entra Agent Identity token it already receives from the auth sidecar.

Built for customers whose artifact repository blocks new packages. Everything the tenant
needs (permissions, DLP policy, labels) is identical to the SDK path, so the module can be
swapped for the SDK middleware later with no tenant changes.

## What it demonstrates

| Scenario | Before | After |
|---|---|---|
| Prompt with a credit card or SSN | answered | **blocked by Purview DLP** before anything reaches Bedrock; alert raised |
| Document with an encrypting sensitivity label | readable | agent **cannot read it** (Purview encryption); with the label gate on, refused before download |
| Every prompt and response | invisible | recorded in **Purview DSPM for AI, Activity explorer**, attributed to the agent and the user |

## How it works

1. `POST /me/dataSecurityAndGovernance/protectionScopes/compute` once per sign-in, to learn which activities Purview wants evaluated (cached with its ETag).
2. `POST /me/dataSecurityAndGovernance/processContent` with `activity: uploadText` before the model; stop on `restrictAccess / block`.
3. Read SharePoint files with the user's own permissions; read the label with `extractSensitivityLabels` (list-item metadata as fallback for encrypted files); refuse labels listed in `PURVIEW_BLOCKED_LABEL_IDS`.
4. `processContent` with `activity: downloadText` after the model, before the answer is shown.

Method: Microsoft Learn, *Use Microsoft Purview APIs to leverage your policies in your apps*
(https://learn.microsoft.com/purview/developer/use-the-api).

## Contents

| Path | Purpose |
|---|---|
| `sidecar/llm-agent-aws/purview_rest.py` | All Purview and SharePoint Graph calls (new file) |
| `sidecar/llm-agent-aws/app.py` | Patched agent: prompt gate, response gate, SharePoint document tool, UI badges |
| `app.py.diff` | The patch against the original `app.py` |
| `sidecar/docker-compose-aws.yml` | New `PURVIEW_*` settings; `DownstreamApis__graph__RequestAppToken=false` (the OBO endpoint must return a delegated token) |
| `sidecar/.env.example` | Settings template (never commit a real `.env`) |
| `tenant-setup/1-Grant-PurviewPermissions.ps1` | Inheritable permissions on the Blueprint + tenant-wide delegated consent for the six Graph scopes |
| `tenant-setup/2-Create-PurviewDlpPolicy.ps1` | DLP policy on the Application enforcement plane, rule at Low confidence, UploadText block |
| `DEMO-RUNBOOK.md` | Talk track and scene-by-scene demo script |
| `Check-NoCustomerData.ps1` | Pre-commit scan for tenant ids, UPNs, secrets and customer names |

## Prerequisites

- The base sample running (Blueprint, Agent Identity, sidecar, AWS credentials).
- Global Administrator for the Entra steps; Compliance Administrator for the DLP step.
- Purview Audit on; pay-as-you-go billing enabled for Purview protections of non-Microsoft AI apps.
- A sensitivity label with encryption published to the demo user.

## Quick start

1. Grant the permissions: `tenant-setup/1-Grant-PurviewPermissions.ps1 -TenantId <id> -BlueprintAppId <id> -AgentIdentityId <id>`
2. Expose `access_as_user` on the Blueprint and register (or reuse) a SPA app for the sign-in; set `CLIENT_SPA_APP_ID`.
3. Copy `purview_rest.py` and `app.py` into `sidecar/llm-agent-aws/`, make the Dockerfile copy both files, replace `docker-compose-aws.yml`, append the `PURVIEW_*` settings to `.env`.
4. `docker compose -f docker-compose-aws.yml up -d --build llm-agent-aws` and `... up -d --force-recreate sidecar`.
5. Create the DLP policy: `tenant-setup/2-Create-PurviewDlpPolicy.ps1 -AgentIdentityId <id> -BlueprintAppId <id> -AlertRecipient <upn>`; wait for *Sync completed*.
6. Test with `Charge credit card 4111 1111 1111 1111 for the Dallas trip` (blocked) and a labelled document (refused).

The accompanying build guide (Word) walks through each step with the exact commands and what to check.

## Lessons learned

- Purview `/me` endpoints need a **delegated** token; an app-only token returns 400.
- An Agent Identity cannot consent interactively (AADSTS82014): use inheritable permissions on the Blueprint plus `oauth2PermissionGrants` on both the Agent Identity and the Blueprint principal.
- DLP for an Entra-registered app can only be created in Security & Compliance PowerShell, not in the portal.
- The default sensitive-information-type confidence never matches a bare number in a chat prompt; use `confidencelevel = "Low"`.
- A `DownloadText` restriction is not supported for Application locations; responses are still evaluated and recorded.
- `078-05-1120` is a voided SSN and is not detected; use `120-98-1437` with the word SSN.
- For encrypted files `extractSensitivityLabels` returns nothing; SharePoint's `_IpLabelId` / `_DisplayName` list-item columns still carry the label.

## Not in scope

Response blocking, Communication Compliance (abusive prompts), file upload/download activities, prompt-injection detection. The label block is an agent-side rule on the label Purview supplies; a DLP rule with a label condition would move that decision to the compliance team.
