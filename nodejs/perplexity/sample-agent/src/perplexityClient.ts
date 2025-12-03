import Perplexity from "@perplexity-ai/perplexity_ai";

// Minimal interface based on observed SDK response shape
interface ChatMessage {
  role: string;
  content: unknown;
}

interface ChatChoice {
  index?: number;
  message?: ChatMessage;
  finish_reason?: string;
}

interface SearchResult {
  title?: string;
  url: string;
  // depending on SDK you might also see snippet, score, etc.
  snippet?: string;
  date?: string;
}

interface ChatCompletionResponse {
  id?: string;
  created?: number;
  model?: string;
  choices?: ChatChoice[];
  search_results?: SearchResult[]; // 👈 important
  [key: string]: unknown;
}

/**
 * Client for interacting with the Perplexity AI SDK.
 */
export class PerplexityClient {
  private client: Perplexity;
  readonly model: string;
  private systemPrompt: string;

  constructor(apiKey: string, model: string, systemPrompt: string) {
    this.client = new Perplexity({ apiKey });
    this.model = model;
    this.systemPrompt = systemPrompt;
  }

  /**
   * Sends a user message to the Perplexity SDK and returns
   * the AI's response *plus* a "Sources" section if available.
   */
  async invokeAgent(userMessage: string): Promise<string> {
    try {
      console.log(
        "🤖 Invoking Perplexity agent with user message:",
        userMessage
      );

      const response = await this.client.chat.completions.create({
        model: this.model, // e.g. "sonar" / "sonar-pro"
        messages: [
          {
            role: "system",
            content: this.systemPrompt,
          },
          { role: "user", content: userMessage },
        ],
        // Sonar does web search by default; no extra flags needed
      });

      const completion = response as unknown as ChatCompletionResponse;
      const choice = completion?.choices?.[0];
      const rawContent = choice?.message?.content;

      // Base answer text
      const answer =
        typeof rawContent === "string"
          ? rawContent
          : JSON.stringify(rawContent ?? completion, null, 2);

      const sources = completion.search_results ?? [];

      if (!sources.length) {
        return answer;
      }

      // Build a numbered list where the *title* is the link
      const sourcesLines = sources.map((s, idx) => {
        let label = s.title?.trim();

        if (!label) {
          // fall back to hostname if no title
          try {
            const hostname = new URL(s.url).hostname.replace(/^www\./, "");
            label = hostname;
          } catch {
            label = s.url;
          }
        }

        // Optional: truncate very long titles
        if (label.length > 80) {
          label = label.slice(0, 77) + "…";
        }

        // Example: "1. [EU AI Act | Shaping Europe's digital future](https://…)"
        return `${idx + 1}. [${label}](${s.url})`;
      });

      const formattedSources =
        `\n\n---\n\n**Sources**\n` + sourcesLines.join("\n");

      return `${answer.trim()}${formattedSources}`;
    } catch (error) {
      console.error("Perplexity agent error:", error);
      const err = error as any;
      return `Error: ${err?.message || String(err)}`;
    }
  }
}
