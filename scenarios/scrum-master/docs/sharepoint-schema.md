# SharePoint schema reference

The scenario stores all persistent state in SharePoint lists on a single site. The
provisioning script [`src/scripts/setup-sharepoint.ts`](../src/scripts/setup-sharepoint.ts)
creates every list below with the exact column schema declared in
[`src/services/sharepoint.ts`](../src/services/sharepoint.ts) (`LIST_SCHEMAS`) — this
document is a human-readable summary of that source-of-truth.

All list display names are prefixed with the value of `SHAREPOINT_LISTS_PREFIX`
(default `SMA_`) so the sample never collides with existing lists on a shared site.

## Site + prefix

| Setting | Env var | Default | Purpose |
|---|---|---|---|
| Site URL | `SHAREPOINT_SITE_URL` | *(required)* | Root of the site that hosts all lists + the doc library |
| List prefix | `SHAREPOINT_LISTS_PREFIX` | `SMA_` | Prepended to every list display name |

## Lists

Column types map to [Microsoft Graph list-column definitions](https://learn.microsoft.com/en-us/graph/api/resources/columndefinition):

- `text` — single-line string
- `note` — multi-line string (used to store small JSON blobs)
- `dateTime` — ISO-8601 timestamp
- `number` — floating-point value
- `boolean` — checkbox

Every list also has SharePoint's built-in `Title` column, which the sample re-uses
where noted.

### `SMA_TeamMembers`

Roster of squad members the agent will DM for standups. Seeded by
[`seed-team.ts`](../src/scripts/seed-team.ts).

| Column | Type | Description |
|---|---|---|
| `Title` | text | Display name (e.g. "Alice") |
| `Email` | text | Primary email — used for Jira account linkage lookups |
| `AadObjectId` | text | Azure AD object id — links the Jira user to the Teams identity |
| `JiraAccountId` | text | Jira `accountId` — used when posting comments and matching assignees |
| `TimeZone` | text | IANA zone (e.g. `Asia/Kolkata`); reserved for future per-user scheduling |
| `Role` | text | Free text — `SM` for the Scrum Master; `Dev` / `QA` for the rest |
| `ConversationRef` | note | Cached Teams conversation reference for proactive DMs |
| `LastSeenUtc` | dateTime | Last activity from this user (for stale-roster warnings) |

### `SMA_TeamsConfig`

The channel where the agent posts standup summaries, sprint risk reports, and the
sprint close report. One row per team.

| Column | Type | Description |
|---|---|---|
| `Title` | text | Single-row lookup key: handlers write and read the literal `primary`, not the channel display name |
| `TeamId` | text | Microsoft Teams team id |
| `ChannelId` | text | Channel id (normalised — thread/message anchors are stripped) |
| `ConversationRef` | note | Cached conversation reference for posting proactively |
| `ConfiguredByAadId` | text | Who ran `/config channel` |
| `ConfiguredAtUtc` | dateTime | When it was configured |

### `SMA_StandupSessions`

One row per standup run — the "did we DM everyone, did they respond, did we
summarise" state machine.

| Column | Type | Description |
|---|---|---|
| `Title` | text | `<sprintId>#<UTC yyyy-mm-dd>` — human-readable run identifier |
| `RunKey` | text, indexed, unique | Same daily value as `Title`; atomic creation claim across live workers |
| `SprintId` | text | Jira sprint id (as string) |
| `StartedUtc` | dateTime | When the DMs went out |
| `CutoffUtc` | dateTime | `StartedUtc + STANDUP_CUTOFF_HOURS` |
| `State` | text | `open` \| `summarized` \| `archived` |
| `ExpectedResponders` | note | JSON array of AAD ids the DMs were sent to |
| `InitiatedByAadId` | text | Who triggered the standup (SM or timer identity) |
| `FanoutSnapshot` | note | Frozen sprint name, per-assignee Jira items and initially unreachable ids; restores open runs after restart |

**Existing-list migration:** pause all agent workers, then run
`npm run setup:sharepoint` against the intended live site. Before changing
records, the script rejects duplicate/empty Titles or existing RunKeys that
disagree with Title. Reconcile such records manually; the script never deletes
history. It adds RunKey when absent, backfills all pages of legacy rows, then
enables indexed uniqueness. Rerunning after a partial migration is safe with
workers still paused. Resume only after success; a build/test does not migrate
the live schema. Creation failures (including an unmigrated schema) stop fan-out.
Setup also adds `FanoutSnapshot` and provisions `SMA_StandupDeliveries`.
Open runs with a snapshot can resume pending request delivery and restore accepted
responses and cutoff timers; legacy runs without one still require inspection.

### `SMA_StandupDeliveries`

One durable delivery claim per reachable member per standup.

| Column | Type | Description |
|---|---|---|
| `Title` | text | `<StandupId>#<UserAadId>` |
| `DeliveryKey` | text, indexed, unique | Same canonical key; prevents duplicate per-member delivery rows |
| `StandupId` | text | Parent run identifier |
| `UserAadId` | text | Expected recipient identity |
| `State` | text | `pending` \| `claimed` \| `sent` \| `uncertain` |
| `DeliveredUtc` | dateTime | Time delivery was confirmed |

Conditional `pending → claimed` protects competing workers. Confirmed pre-send
failures and non-408 4xx rejections return to `pending`; retries skip `sent` rows.
Ambiguous sends retain `uncertain`, while crashes or post-send persistence failures
can retain `claimed`. Inspect Teams before marking such rows `sent` or returning
them to `pending`; never reset a claim merely because a retry fired.

### `SMA_StandupResponses`

One row per person per standup — the actual card payload they submitted.

| Column | Type | Description |
|---|---|---|
| `Title` | text | `<StandupId>#<UserAadId>` — canonical response label |
| `ResponseKey` | text, indexed, unique | Same canonical key; atomic first-response claim |
| `StandupId` | text | Foreign key to `SMA_StandupSessions.Title` |
| `UserAadId` | text | Responder AAD id |
| `SubmittedUtc` | dateTime | When the card was submitted |
| `Items` | note | JSON array — one item per issue with `update` + optional `blockerText` |

Repeated/concurrent submissions for a responder keep the first accepted payload
and return its acknowledgement without repeating Jira comments or blocker writes.
Before upgrading an existing list, pause all workers and run
`npm run setup:sharepoint`. It validates distinct Titles matching StandupId/UserAadId,
backfills ResponseKey across all pages, then enables uniqueness. Duplicate or
malformed legacy rows must be reconciled manually; migration does not delete them.
Interrupted migrations can be rerun with workers still paused. A persisted response
claim is not an outbox: interrupted downstream side effects need operator inspection,
not replaying the card.

### `SMA_Blockers`

One row per blocker flagged in a standup response. Drives the MVP-3 chase flow.
Rows are scoped to the issue key plus `StandupId`: a later standup creates a
new episode rather than reopening the old row. Prior meeting IDs and booking
claims remain on their original rows; card actions identify the exact row ID.
Updating an existing episode preserves its state and meeting metadata.

| Column | Type | Description |
|---|---|---|
| `Title` | text | Short label — usually the issue key |
| `StandupId` | text | Where the blocker was reported |
| `ReporterAadId` | text | Who flagged it |
| `OwnerAadId` | text | Who owns the issue (from Jira) |
| `BlockerText` | note | Free text the reporter typed |
| `State` | text | `open` \| `meeting-proposed` \| `booked` \| `resolved` |
| `MeetingEventId` | text | Outlook event id after the unblock meeting is booked |

### `SMA_SprintRisks`

One daily Warn-check delivery claim per sprint (UTC day). Explicit forced alerts
use a UUID suffix and deliberately bypass daily suppression.

| Column | Type | Description |
|---|---|---|
| `Title` | text | `<sprintId>#<yyyy-mm-dd>` |
| `RiskKey` | text, indexed, unique | Same value as `Title`; atomic creation claim across workers |
| `SprintId` | text | Jira sprint id |
| `DetectedUtc` | dateTime | When the risk was detected |
| `Reason` | note | Human-readable summary of which thresholds tripped |
| `PointsToDoPct` | number | Percentage (0–100) of points, or items when estimates are incomplete, still in `To Do` |
| `Payload` | note | JSON snapshot of the sprint state used for the decision |
| `State` | text | `pending` → `claimed` (conditional delivery claim) → `delivered`; legacy rows without a state can be claimed |
| `DeliveredUtc` | dateTime | Timestamp of confirmed DM delivery; empty for pending notifications |

**Existing-list migration:** pause every worker and run `npm run setup:sharepoint`
against the intended live site/prefix before starting upgraded workers. The script
reads all column/item pages and rejects duplicate/empty/malformed Titles,
Titles inconsistent with SprintId/DetectedUtc, or existing RiskKeys inconsistent
with Title **before any mutation**. Reconcile conflicting history manually;
the script never deletes rows or guesses which duplicate was delivered. It adds
missing RiskKey/State/DeliveredUtc columns, backfills RiskKey from Title, then
enables indexed uniqueness. Interrupted migrations can be rerun while workers
remain paused. Resume only after success; tests/builds do not migrate live sites.

Existing pending/legacy rows require an ETag-conditional state transition before
sending; concurrent initial detections compete on unique RiskKey. Confirmed
pre-send failures and explicit connector rejections (HTTP 4xx except timeout)
release the claim for retry. Transport/timeouts, ambiguous send outcomes, process
crashes, or failed delivery-state persistence retain `claimed` to avoid duplicate
DMs. There is no automatic lease expiry/replay. An operator must inspect Teams
delivery before changing a stranded claim to `delivered` (with DeliveredUtc) or,
only after confirming no delivery, `pending`. Legacy rows without State remain
retryable, so inspect their historical delivery before resuming after migration.

### `SMA_HelperRoster`

Subject-matter experts the chase flow uses to find an unblock helper. Seeded by
[`seed-helper-roster.ts`](../src/scripts/seed-helper-roster.ts).

| Column | Type | Description |
|---|---|---|
| `Title` | text | Topic name (e.g. `IT / Access / Data platform`) |
| `Keywords` | note | Comma-separated keywords matched against the blocker text |
| `HelperEmail` | text | Contactable email — used to look up the AAD user for the meeting invite |
| `HelperDisplayName` | text | Shown on the "propose unblock meeting" card |
| `IsActive` | boolean | `false` to temporarily disable a helper without deleting the row |

## Document library

### `SprintReports` (optional)

Historical archive of sprint-close reports as markdown files. The current sample
posts reports inline to the configured channel — the doc library is provisioned by
`setup-sharepoint.ts` and left for consumers who want to move report output
off-channel.

## Provisioning

Provisioning is idempotent — missing lists and supported column migrations
are applied without deleting existing history:

```powershell
npm run setup:sharepoint
```

For every list, the script first queries
`GET /sites/{siteId}/lists?$filter=displayName eq '<name>'`; only missing lists are
created. Existing standup lists receive the RunKey migration described above;
existing risk lists receive the RiskKey/delivery-state migration described above. Other schema
changes require an explicit migration. Do not delete operational lists to
bypass delivery or creation claims.

## Permissions required

The setup script signs in with delegated Microsoft Graph scopes (`Sites.Manage.All`
+ `Sites.ReadWrite.All`) via device-code flow. See the top of
[`src/services/graph.ts`](../src/services/graph.ts) for the exact `GRAPH_SCOPES`
list. Runtime uses the same delegated token, refreshed silently through the local
MSAL cache. The public-client application must be allowed to request those
delegated permissions; tenant consent policy can require administrator approval.
Application permissions are not used by this sample.

## Reusing a site with a new blueprint

A new agent blueprint does not require new SharePoint lists when the tenant,
`SHAREPOINT_SITE_URL`, and `SHAREPOINT_LISTS_PREFIX` are unchanged. Run
`npm run setup:sharepoint` to sign in on a fresh machine and create only missing
lists. Existing lists and their items are preserved; do not run the seed scripts
unless you intend to insert or update roster data.
The setup script preserves existing lists and applies only the supported key and
delivery-state migrations described above.

Conversation references belong to the agent conversation, not just the user.
After creating a new blueprint and agent instance, have every participating user
message the new agent once to refresh `SMA_TeamMembers.ConversationRef`, then run
`/config channel` in the target Teams channel to refresh its configuration.
Keep `LOCAL_CRON=false` until these references and the roster are verified.

For a different tenant, provision the lists in an accessible site in that tenant
and migrate required business data separately. Do not copy old conversation
references or assume that user, team, and channel IDs remain valid.
