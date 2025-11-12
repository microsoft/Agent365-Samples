import { TurnState, AgentApplication, AttachmentDownloader, MemoryStorage, TurnContext } from '@microsoft/agents-hosting';
import { ActivityTypes } from '@microsoft/agents-activity';
import { AgentNotificationActivity } from '@microsoft/agents-a365-notifications';
import { PerplexityAgent } from './perplexityAgent.js';

interface ConversationState {
  count: number;
}
type ApplicationTurnState = TurnState<ConversationState>

const downloader = new AttachmentDownloader();
const storage = new MemoryStorage();

export const agentApplication = new AgentApplication<ApplicationTurnState>({
  storage,
  fileDownloaders: [downloader]
});

const perplexityAgent = new PerplexityAgent(undefined);

// Route agent notifications
agentApplication.onAgentNotification("*", async (context: TurnContext, state: ApplicationTurnState, activity: AgentNotificationActivity) => {
  await perplexityAgent.handleAgentNotificationActivity(context, state, activity);
});

agentApplication.onActivity(ActivityTypes.Message, async (context: TurnContext, state: ApplicationTurnState) => {
  // Increment count state
  let count = state.conversation.count ?? 0;
  state.conversation.count = ++count;

  await perplexityAgent.handleAgentMessageActivity(context, state);
});

agentApplication.onActivity(ActivityTypes.InstallationUpdate, async (context: TurnContext, state: ApplicationTurnState) => {
  await perplexityAgent.handleInstallationUpdateActivity(context, state);
});
