import { InferenceScope, InvokeAgentScope, TenantDetails, InvokeAgentDetails, InferenceOperationType } from '@microsoft/agents-a365-observability';
import { McpServer } from './mcpToolRegistrationService';

export class N8nClient {
  mcpServers: McpServer[];

  constructor(mcpServers?: McpServer[]) {
    this.mcpServers = mcpServers ?? [];
  }

  /**
   * Generate a response based on the incoming message
   */
  private async generateResponse(messageContent: string, fromUser: string = ''): Promise<string | null> {

    const body = JSON.stringify(
      {
        "type": "message",
        "text": messageContent,
        "id": "b30d2fa7-f9f2-4e8f-8947-904063e4a8bd",
        "from": fromUser,
        "timestamp": "2025-10-02T16:10:59.882Z",
        "textFormat": "plain",
        "locale": "en-US",
        "mcpServers": this.mcpServers
      }
    );

    if (!process.env.N8N_WEBHOOK_URL) {
      throw new Error('N8N_WEBHOOK_URL environment variable is not set.');
    }
    const response = await fetch(process.env.N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.N8N_WEBHOOK_AUTH_HEADER ? { 'Authorization': process.env.N8N_WEBHOOK_AUTH_HEADER } : {})
      },
      body: body
    });

    if (!response.ok) {
      console.error(`n8n webhook returned error status: ${response.status} ${response.statusText}`);
      return null;
    }

    let result: { output: string } | null = null;
    try {
      result = await response.json() as { output: string };
    } catch (err) {
      console.error('Failed to parse n8n webhook response as JSON:', err);
      return null;
    }

    if (!result || typeof result.output !== 'string') {
      console.error('n8n webhook response JSON missing expected "output" property:', result);
      return null;
    }

    return result.output;
  }

  async invokeAgent(userMessage: string, fromUser: string = '') {
    let response = "";
    try {
      response = await this.generateResponse(userMessage, fromUser) || ''
      if (!response) {
        return "Sorry, I couldn't get a response from n8n :(";
      }
      return response;
    } catch (error) {
      console.error('Agent query error:', error);
      return `Error: ${error}`;
    }
  }

  public async invokeAgentWithScope(userMessage: string, fromUser: string = '') {
    const agentDetails = { agentId: process.env.AGENT_ID || 'sample-agent' };

    const invokeAgentDetails: InvokeAgentDetails = {
      ...agentDetails,
      agentName: 'n8n Agent',
    };

    const tenantDetails: TenantDetails = {
      tenantId: 'n8n-sample-tenant',
    };

    const invokeAgentScope = InvokeAgentScope.start(invokeAgentDetails, tenantDetails);

    if (!invokeAgentScope) {
      // fallback: do the work without active parent span
      await new Promise((resolve) => setTimeout(resolve, 200));
      return await this.invokeAgent(userMessage, fromUser);
    }

    try {
      return await invokeAgentScope.withActiveSpanAsync(async () => {
        // Create the inference (child) scope while the invoke span is active
        const scope = InferenceScope.start({
          model: 'n8n-workflow',
          providerName: 'n8n',
          operationName: InferenceOperationType.CHAT,
        }, agentDetails, tenantDetails);

        if (!scope) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return await this.invokeAgent(userMessage, fromUser);
        }

        try {
          // Activate the inference span for the inference work
          const result = await scope.withActiveSpanAsync(async () => {
            const response = await this.invokeAgent(userMessage, fromUser);
            scope.recordOutputMessages([response || '']);
            return response;
          });
          return result;
        } catch (error) {
          scope.recordError(error as Error);
          throw error;
        } finally {
          scope.dispose();
        }
      });
    } finally {
      invokeAgentScope.dispose();
    }
  }
}
