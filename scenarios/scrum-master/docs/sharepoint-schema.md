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

**Existing-list migration:** pause all agent workers, then run
`npm run setup:sharepoint` against the intended live site. Before changing
records, the script rejects duplicate/empty Titles or existing RunKeys that
disagree with Title. Reconcile such records manually; the script never deletes
history. It adds RunKey when absent, backfills all pages of legacy rows, then
enables indexed uniqueness. Rerunning after a partial migration is safe with
workers still paused. Resume only after success; a build/test does not migrate
the live schema. Creation failures (including an unmigrated schema) stop fan-out.
The claim is not a distributed response store or a mechanism to resume crashed runs.

### `SMA_StandupResponses`

One row per person per standup — the actual card payload they submitted.

| Column | Type | Description |
|---|---|---|
| `Title` | text | `<StandupId>#<UserAadId>` — idempotency key |
| `StandupId` | text | Foreign key to `SMA_StandupSessions.Title` |
| `UserAadId` | text | Responder AAD id |
| `SubmittedUtc` | dateTime | When the card was submitted |
| `Items` | note | JSON array — one item per issue with `update` + optional `blockerText` |

### `SMA_Blockers`

One row per blocker flagged in a standup response. Drives the MVP-3 chase flow.

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

Row per Warn-check firing (MVP 4). Used to suppress duplicate alerts on the same
sprint within a short window.

| Column | Type | Description |
|---|---|---|
| `Title` | text | `<sprintId>#<yyyy-mm-dd>` |
| `SprintId` | text | Jira sprint id |
| `DetectedUtc` | dateTime | When the risk was detected |
| `Reason` | note | Human-readable summary of which thresholds tripped |
| `PointsToDoPct` | number | Fraction of committed points still in `To Do` |
| `Payload` | note | JSON snapshot of the sprint state used for the decision |
| `State` | text | `pending` until the Scrum Master DM succeeds, then `delivered`; legacy rows without a state are retryable |
| `DeliveredUtc` | dateTime | Timestamp of confirmed DM delivery; empty for pending notifications |

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
existing risk lists receive missing delivery-state columns. Other schema
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
The setup script skips existing lists; it does not migrate their schemas.

Conversation references belong to the agent conversation, not just the user.
After creating a new blueprint and agent instance, have every participating user
message the new agent once to refresh `SMA_TeamMembers.ConversationRef`, then run
`/config channel` in the target Teams channel to refresh its configuration.
Keep `LOCAL_CRON=false` until these references and the roster are verified.

For a different tenant, provision the lists in an accessible site in that tenant
and migrate required business data separately. Do not copy old conversation
references or assume that user, team, and channel IDs remain valid.
