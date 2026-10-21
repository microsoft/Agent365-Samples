// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ChatOpenAI, AzureChatOpenAI } from "@langchain/openai";
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { flightSearchTool } from "../tools/flightSearchTool.js";
import { hotelSearchTool } from "../tools/hotelSearchTool.js";
import { restaurantSearchTool } from "../tools/restaurantSearchTool.js";

const SYSTEM_PROMPT =
  "You are a helpful travel assistant. " +
  "Given a destination and travel dates, you help users plan trips by suggesting flights, hotels, and restaurants.\n\n" +
  "When a user provides a destination and dates:\n" +
  "1. Search for 3 flight options using SearchFlights\n" +
  "2. Search for 3 hotel options using SearchHotels\n" +
  "3. If the user asks about restaurants, use SearchRestaurants with mealType 'breakfast', 'lunch', or 'dinner' separately\n\n" +
  "When asked to create a travel summary, compile all suggestions into a well-formatted summary that includes:\n" +
  "- Flight options\n" +
  "- Hotel options\n" +
  "- Restaurant recommendations for breakfast, lunch, and dinner (search for all three if not already done)\n\n" +
  "Always present information in a clear, organized format. Be enthusiastic and helpful about travel planning.";

const tools = [flightSearchTool, hotelSearchTool, restaurantSearchTool];

function createLLM(opts: Record<string, unknown> = {}): ChatOpenAI | AzureChatOpenAI {
  if (process.env.AZURE_OPENAI_API_KEY) {
    return new AzureChatOpenAI({
      azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
      azureOpenAIEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
      azureOpenAIApiDeploymentName: process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-4o",
      azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION ?? "2024-02-01",
      ...opts,
    });
  }
  return new ChatOpenAI({
    openAIApiKey: process.env.OPENAI_API_KEY,
    modelName: process.env.OPENAI_MODEL ?? "gpt-4o",
    ...opts,
  });
}

const toolMap = new Map<string, (input: any) => Promise<any>>();
for (const t of tools) {
  const tool = t;
  toolMap.set(tool.name, (input: any) => (tool as any).invoke(input));
}

export class TravelAgent {
  private llm: ReturnType<ReturnType<typeof createLLM>["bindTools"]>;
  private history: Map<string, (HumanMessage | AIMessage)[]>;

  constructor() {
    this.llm = createLLM({ temperature: 0.3 }).bindTools(tools);
    this.history = new Map();
  }

  private getHistory(sessionId: string): (HumanMessage | AIMessage)[] {
    if (!this.history.has(sessionId)) this.history.set(sessionId, []);
    return this.history.get(sessionId)!;
  }

  async run(sessionId: string, userText: string): Promise<string> {
    const history = this.getHistory(sessionId);
    history.push(new HumanMessage(userText));

    const messages: any[] = [new SystemMessage(SYSTEM_PROMPT), ...history];

    while (true) {
      const response = await this.llm.invoke(messages);
      messages.push(response);

      if (!response.tool_calls?.length) {
        const text = typeof response.content === "string"
          ? response.content
          : (response.content as Array<{ text?: string }>).map(c => c.text ?? "").join("");
        history.push(new AIMessage(text));
        return text;
      }

      for (const toolCall of response.tool_calls) {
        const fn = toolMap.get(toolCall.name);
        if (fn) {
          const result = await fn(toolCall);
          messages.push(result);
        } else {
          messages.push(new ToolMessage({ content: `Unknown tool: ${toolCall.name}`, tool_call_id: toolCall.id! }));
        }
      }
    }
  }
}
