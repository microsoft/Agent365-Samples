# Deploy Travel Agent AWS: step-by-step guide

This guide puts your own copy of Travel Agent AWS on AWS so you can chat with it in Microsoft Teams.
You only need a web browser. Nothing to install, no code, no commands.

**Time:** about 10 minutes (the deploy itself takes about 2).

| Part | Who | What |
|---|---|---|
| [1. Before you start](#part-1-before-you-start) | You | Collect 5 things |
| [2. Deploy](#part-2-deploy-about-5-minutes) | You | Fill in a form in AWS and click **Create stack** |
| [3. Check and send](#part-3-check-it-works-and-send-the-link-to-your-admin) | You | Check it works, send one link to your admin |
| [4. Chat in Teams](#part-4-start-using-the-agent-in-teams) | You | Add the agent in Teams and say hello |
| [For admins](#for-admins-prepare-and-connect-each-agent) | Agent 365 admin | Prepare the values, then connect the agent to Teams |

---

## Part 1: Before you start

Make sure you have these 5 things. Your Agent 365 admin sends you items 2 to 5.

| # | What | What it looks like |
|---|---|---|
| 1 | **An AWS sign-in with administrator access** | Your AWS email/user name and password. Not sure you're an administrator? Ask whoever manages your AWS account. |
| 2 | **Deploy link** | A long link that starts with `https://` and contains `cloudformation` |
| 3 | **Agent blueprint ID** | `11111111-2222-3333-4444-555555555555` (example) |
| 4 | **Agent blueprint client secret** | A long random-looking text. Treat it like a password: don't share it. |
| 5 | **Microsoft 365 tenant ID** | `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee` (example) |

> **Tip:** Open this guide in one browser window and the deploy link in another, so you can follow
> along.

---

## Part 2: Deploy (about 5 minutes)

**Step 1. Open the deploy link** (item 2).

- If AWS asks you to sign in, sign in with item 1. The right page opens after you sign in.
- You now see a page called **Quick create stack**.
- In the top-right corner you see a Region name, such as **United States (Ohio)**. Don't change it.

**Step 2. Check the stack name.**

- **Stack name** already says `travelagentdw`. Leave it.

**Step 3. Paste your three values.**

Under **Agent 365 values (from your Agent 365 admin)**, paste:

| Box | Paste |
|---|---|
| **Agent blueprint ID** | item 3 |
| **Agent blueprint client secret** | item 4. It shows as dots; that's normal. |
| **Microsoft 365 tenant ID** | item 5 |

> Copy and paste the values instead of typing them, and make sure there are no spaces before or after.

**Step 4. Leave everything else as it is.**

- Don't change the **Optional** and **Advanced (leave as is)** sections, or anything below them.

**Step 5. Tick the box at the bottom.**

- Scroll to the bottom of the page.
- Tick **I acknowledge that AWS CloudFormation might create IAM resources.**

**Step 6. Click Create stack.**

**Step 7. Wait about 2 minutes.**

- The status shows **CREATE_IN_PROGRESS**.
- Click the refresh button (the circular arrow) every 30 seconds or so.
- When the status shows **CREATE_COMPLETE**, the deploy is done.
- If you see **ROLLBACK** or **FAILED** instead, go to [Troubleshooting](#troubleshooting).

---

## Part 3: Check it works and send the link to your admin

**Step 8. Click the Outputs tab** (near the top of the stack page).

**Step 9. Check the agent is running.**

- Open the **HealthCheck** link (click it, or copy it into a new browser tab).
- You should see a short message that includes `"status":"healthy"`. This means your agent is
  running on AWS.

**Step 10. Send the agent's address to your admin.**

- Copy the **MessagingEndpoint** value. It ends with `/api/messages`.
- Send it to your Agent 365 admin with a message like: *"My Travel Agent is deployed. Here is my
  MessagingEndpoint: (paste)."*
- Your admin connects it to Teams and tells you when it's ready (usually the same day).

---

## Part 4: Start using the agent in Teams

Do this after your admin tells you the agent is ready.

**Step 11. Find the agent.** In Microsoft Teams, open **Apps** and look under **Agents for your team**,
or search for the agent's name (your admin tells you the name).

**Step 12. Request it.** Open the agent and select **Request instance**. Your admin approves the
request.

**Step 13. Create it.** After approval, open the agent again and select **Create instance**. Give it
a name without spaces or special characters, leave the other fields as they are, and select **Save**.

**Step 14. Say hello.** The agent sends you a chat message in Teams. Try:
*"Find flights from Seattle to New York next Friday."*

> The first reply can take up to a minute while the agent starts.

---

## Troubleshooting

| What you see | What to do |
|---|---|
| A sign-in page when you open the deploy link | Sign in to the AWS account your admin told you to use. The form opens after you sign in. |
| A message about **capabilities** or **IAM resources** when you click **Create stack** | Tick the box in step 5, then click **Create stack** again. |
| A box turns red (for example, "must be a GUID") | The value has a typo or extra spaces. Copy it again from your admin's message. |
| **Stack [travelagentdw] already exists** | You already deployed it in this AWS account. Open **CloudFormation** > **Stacks** > **travelagentdw** > **Outputs** and continue from step 9. |
| **CREATE_FAILED** on **AppLogGroup** or **AppLocalLogGroup** with **/aws/lambda/web/travelagentdw already exists** | An earlier deployment with the `deploy-aws.ps1` script left its log groups behind. Ask your admin to run `aws logs delete-log-group --log-group-name /aws/lambda/web/travelagentdw` and `aws logs delete-log-group --log-group-name /aws/lambda/web/travelagentdw.local` in that Region, or set **Advanced** > **Function name** to a different name. Then delete the failed stack and deploy again. |
| **CREATE_FAILED** on **PackageCopy** with **package SHA-256 mismatch** | The code package doesn't match the release the link was made for. Don't retry; ask your admin for a new deploy link. |
| Status **ROLLBACK_COMPLETE**, **ROLLBACK_IN_PROGRESS**, or **CREATE_FAILED** | Open the **Events** tab, take a screenshot of the first red row that says **CREATE_FAILED**, and send it to your admin. Then select **Delete**, confirm, and try again after they reply. |
| **not authorized** or **AccessDenied** | Your AWS sign-in isn't an administrator. Ask your AWS account owner to deploy it, or to give you administrator access. |
| The **HealthCheck** page doesn't open | Wait one minute and try again. |
| The agent doesn't reply in Teams | 1) Check your admin has finished connecting your MessagingEndpoint. 2) If your AWS account is brand new, AWS can take up to about 2 hours before the agent's AI model works. Try again later. 3) Still nothing? Open the **Logs** link on the **Outputs** tab, take a screenshot, and send it to your admin. |

## Remove the agent

1. In the AWS console, open **CloudFormation** > **Stacks** and select **travelagentdw**.
2. Select **Delete**, then confirm.
3. Wait about 1 minute. Everything the deploy created is removed.
4. Tell your admin, so they can remove the agent from Teams.

---

## For admins: prepare and connect each agent

Each AWS deployment gets its own web address, so **each person needs their own agent blueprint**.
These steps need the Agent 365 CLI (`a365`), the Azure CLI (`az`), and an admin who can grant
consent in the Microsoft 365 tenant.

### Once: publish the deploy link

From `nodejs\langchain\travel-agent-aws` in your clone of `microsoft/Agent365-Samples`,
signed in to the AWS account that hosts the releases:

```powershell
aws login
./aws/publish-launch-stack.ps1 -Share Public
# or, to limit it to your AWS Organization:
./aws/publish-launch-stack.ps1 -Share Organization -OrganizationId o-xxxxxxxxxx
```

The script prints one deploy link per Region. Send people the link for the Region they should
deploy to. Each link shares only that release's package and template, and the template carries
the package's SHA-256: the stack refuses a package whose hash doesn't match the release. Lambda Web
Functions is available in:

| Region code | Region name shown in the AWS console |
|---|---|
| `us-east-1` | United States (N. Virginia) |
| `us-east-2` | United States (Ohio) |
| `us-west-2` | United States (Oregon) |
| `eu-west-1` | Europe (Ireland) |
| `ap-northeast-1` | Asia Pacific (Tokyo) |

### For each person: create their agent blueprint

1. Create a folder for the agent, such as `C:\agents\travel-alex`. Copy `ToolingManifest.json` from
   the `travel-agent-aws` sample folder into it, so the agent gets its Word and OneDrive tools. Open a terminal
   in that folder.
2. Sign in to the Microsoft 365 tenant and create the blueprint:

   ```powershell
   az login --allow-no-subscriptions --tenant <tenant-id>
   a365 setup all --agent-name "Travel Agent Alex" --aiteammate --m365
   ```

   When it asks for **Messaging endpoint URL**, leave it blank and press Enter. You register it
   after the person deploys. Complete any sign-in or consent prompts.
3. Collect the three values:

   | Value | Where to find it |
   |---|---|
   | Agent blueprint ID | `agentBlueprintId` in `a365.generated.config.json` |
   | Agent blueprint client secret | `a365 setup blueprint --show-secret`, run in the agent's folder (on the same computer and Windows user that ran setup) |
   | Microsoft 365 tenant ID | `az account show --query tenantId -o tsv` |

4. Send the person this guide, the deploy link, and the three values. Send the client secret
   separately and securely, for example through a password manager. Don't put it in plain email or
   chat. You can use this message:

   > Hi Alex, here's what you need to deploy your Travel Agent on AWS. Follow the guide:
   > (link to this guide)
   >
   > - AWS account to use: (account name or sign-in link)
   > - Deploy link: (link)
   > - Agent blueprint ID: (value)
   > - Microsoft 365 tenant ID: (value)
   > - Agent blueprint client secret: sent separately

### When the person sends back their MessagingEndpoint

1. In that agent's folder, register the address. This is also the stack's **AdminCommand** output:

   ```powershell
   a365 setup blueprint --update-endpoint <MessagingEndpoint> --m365
   ```

2. Package the agent for Teams:

   ```powershell
   a365 publish
   ```

   This creates `manifest\manifest.zip`. Check the name and description in `manifest\manifest.json`,
   and run `a365 publish` again if you change them.
3. Upload it: in the [Microsoft 365 admin center](https://admin.microsoft.com), go to **Agents** >
   **All agents** > **Upload custom agent** and choose `manifest.zip`.
4. Tell the person to continue with [Part 4](#part-4-start-using-the-agent-in-teams). When they
   select **Request instance**, approve it at
   [Requested agents](https://admin.cloud.microsoft/#/agents/all/requested).

### Later

- **Change a person's AI model:** in their AWS account, open the stack and select **Update**. Keep
  the existing template, change **Bedrock model ID** (for example `us.amazon.nova-pro-v1:0`), and
  finish the wizard, ticking the IAM box at the end. The address stays the same. Claude models need
  the Anthropic use-case form in that AWS account first.
- **New release:** run the publish script again and send new deployments the new link. Existing
  deployments keep running. Each one has its own copy of the code.
- **More detail:** see "One-click deploy without tools" in the [README](../README.md).
