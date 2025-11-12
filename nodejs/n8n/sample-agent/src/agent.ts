import { TurnState, AgentApplication, AttachmentDownloader, MemoryStorage, TurnContext } from '@microsoft/agents-hosting';
import { ActivityTypes } from '@microsoft/agents-activity';
import { N8nAgent } from './n8nAgent';

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

const n8nAgent = new N8nAgent(undefined);

agentApplication.onActivity(ActivityTypes.Message, async (context: TurnContext, state: ApplicationTurnState) => {
  // Increment count state
  let count = state.conversation.count ?? 0;
  state.conversation.count = ++count;

  await n8nAgent.handleAgentMessageActivity(context, state);
});

agentApplication.onActivity(ActivityTypes.InstallationUpdate, async (context: TurnContext, state: ApplicationTurnState) => {
  await n8nAgent.handleInstallationUpdateActivity(context, state);
});

