import {
  TurnState,
  AgentApplication,
  AttachmentDownloader,
  MemoryStorage,
  TurnContext,
} from "@microsoft/agents-hosting";
import { ActivityTypes } from "@microsoft/agents-activity";
import { AgentNotificationActivity } from "@microsoft/agents-a365-notifications";
import { PerplexityAgent } from "./perplexityAgent.js";
import {
  MentionInWordValue,
  PlaygroundActivityTypes,
  SendEmailActivity,
} from "./playgroundActivityTypes.js";

/**
 * Conversation state interface for tracking message count.
 */
interface ConversationState {
  count: number;
}

/**
 * ApplicationTurnState combines TurnState with our ConversationState.
 */
type ApplicationTurnState = TurnState<ConversationState>;

/**
 * Instantiate the AttachmentDownloader.
 */
const downloader: AttachmentDownloader = new AttachmentDownloader();

/**
 * Instantiate the MemoryStorage.
 */
const storage: MemoryStorage = new MemoryStorage();

/**
 * Create the Agent Application instance with typed state.
 */
export const agentApplication: AgentApplication<ApplicationTurnState> =
  new AgentApplication<ApplicationTurnState>({
    storage,
    fileDownloaders: [downloader],
  });

/**
 * Instantiate the PerplexityAgent.
 */
const perplexityAgent: PerplexityAgent = new PerplexityAgent(undefined);

/* --------------------------------------------------------------------
 * ✅ Real Notification Events (Production)
 * These handlers process structured AgentNotificationActivity objects
 * sent by Microsoft 365 workloads (Word, Outlook, etc.) in production.
 * -------------------------------------------------------------------- */

/**
 * Handles ALL real notification events from any workload.
 * Fires when an AgentNotificationActivity is received.
 * Use this for generic notification handling logic.
 */
agentApplication.onAgentNotification(
  "*",
  async (
    context: TurnContext,
    state: ApplicationTurnState,
    activity: AgentNotificationActivity
  ): Promise<void> => {
    await perplexityAgent.handleAgentNotificationActivity(
      context,
      state,
      activity
    );
  }
);

/**
 * Handles Word-specific notifications (e.g., comments, mentions in Word).
 * Fires only for AgentNotificationActivity originating from Word.
 */
agentApplication.onAgenticWordNotification(
  async (
    context: TurnContext,
    state: ApplicationTurnState,
    activity: AgentNotificationActivity
  ): Promise<void> => {
    await perplexityAgent.handleAgentNotificationActivity(
      context,
      state,
      activity
    );
  }
);

/**
 * Handles Email-specific notifications (e.g., new mail, flagged items).
 * Fires only for AgentNotificationActivity originating from Outlook/Email.
 */
agentApplication.onAgenticEmailNotification(
  async (
    context: TurnContext,
    state: ApplicationTurnState,
    activity: AgentNotificationActivity
  ): Promise<void> => {
    await perplexityAgent.handleAgentNotificationActivity(
      context,
      state,
      activity
    );
  }
);

/* --------------------------------------------------------------------
 * ✅ Playground Events (Simulated for Testing)
 * These handlers process custom activityType strings sent via sendActivity()
 * from the Playground UI. They DO NOT trigger real notification handlers.
 * -------------------------------------------------------------------- */

/**
 * Handles simulated Word mention notifications.
 * activityType: "mentionInWord"
 * Useful for testing Word-related scenarios without real notifications.
 */
agentApplication.onActivity(
  PlaygroundActivityTypes.MentionInWord,
  async (context: TurnContext, _state: ApplicationTurnState): Promise<void> => {
    const value: MentionInWordValue = context.activity
      .value as MentionInWordValue;
    const docName: string = value.mention.displayName;
    const docUrl: string = value.docUrl;
    const userName: string = value.mention.userPrincipalName;
    const contextSnippet: string = value.context
      ? `Context: ${value.context}`
      : "";
    const message: string = `✅ You were mentioned in **${docName}** by ${userName}\n📄 ${docUrl}\n${contextSnippet}`;
    await context.sendActivity(message);
  }
);

/**
 * Handles simulated Email notifications.
 * activityType: "sendEmail"
 * Useful for testing email scenarios without real notifications.
 */
agentApplication.onActivity(
  PlaygroundActivityTypes.SendEmail,
  async (context: TurnContext, _state: ApplicationTurnState): Promise<void> => {
    const activity: SendEmailActivity = context.activity as SendEmailActivity;
    const email = activity.value;

    const message: string = `📧 Email Notification:
    From: ${email.from}
    To: ${email.to.join(", ")}
    Subject: ${email.subject}
    Body: ${email.body}`;

    await context.sendActivity(message);
  }
);

/**
 * Handles a generic custom notification.
 * Custom activityType: "custom"
 * ✅ To add more custom activities:
 *    - Define a new handler using agentApplication.onActivity("<yourType>", ...)
 *    - Implement logic similar to this block.
 */
agentApplication.onActivity(
  PlaygroundActivityTypes.Custom,
  async (context: TurnContext, _state: ApplicationTurnState): Promise<void> => {
    await context.sendActivity("this is a custom activity handler");
  }
);

/* --------------------------------------------------------------------
 * ✅ Generic Activity Handlers
 * These handle standard activity types like messages or installation updates.
 * -------------------------------------------------------------------- */

/**
 * Handles standard message activities (ActivityTypes.Message).
 * Increments conversation count and delegates to PerplexityAgent.
 */
agentApplication.onActivity(
  ActivityTypes.Message,
  async (context: TurnContext, state: ApplicationTurnState): Promise<void> => {
    let count: number = state.conversation.count ?? 0;
    state.conversation.count = ++count;

    await perplexityAgent.handleAgentMessageActivity(context, state);
  }
);

/**
 * Handles installation update activities (ActivityTypes.InstallationUpdate).
 * Useful for responding to app installation or update events.
 */
agentApplication.onActivity(
  ActivityTypes.InstallationUpdate,
  async (context: TurnContext, state: ApplicationTurnState): Promise<void> => {
    await perplexityAgent.handleInstallationUpdateActivity(context, state);
  }
);
