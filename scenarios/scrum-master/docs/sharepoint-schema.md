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
| `Title` | text | Friendly channel name |
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
| `Title` | text | `<sprintId>#<yyyy-mm-dd>` — idempotency key |
| `SprintId` | text | Jira sprint id (as string) |
| `StartedUtc` | dateTime | When the DMs went out |
| `CutoffUtc` | dateTime | `StartedUtc + STANDUP_CUTOFF_HOURS` |
| `State` | text | `pending` \| `summarized` |
| `ExpectedResponders` | note | JSON array of AAD ids the DMs were sent to |
| `InitiatedByAadId` | text | Who triggered the standup (SM or timer identity) |

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

Provisioning is idempotent — running the setup script twice is a no-op:

```powershell
npm run setup:sharepoint
```

For every list, the script first queries
`GET /sites/{siteId}/lists?$filter=displayName eq '<name>'`; only missing lists are
created. Column schemas are not migrated after creation — if you change
`LIST_SCHEMAS`, delete the affected list in SharePoint before re-running the
script (or add a migration step to `setup-sharepoint.ts`).

## Permissions required

The setup script signs in with delegated Microsoft Graph scopes (`Sites.Manage.All`
+ `Sites.ReadWrite.All`) via device-code flow. See the top of
[`src/services/graph.ts`](../src/services/graph.ts) for the exact `GRAPH_SCOPES`
list. Runtime uses the same delegated token, refreshed silently through the local
MSAL cache — no admin consent or application permissions are required.
