// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

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
   * Supports text and file attachments (PDFs, DOCX, images, audio, video, etc.).
   */
  async invokeAgent(
    userMessage: string,
    fileAttachments: Array<{
      name: string;
      base64: string;
      contentType: string;
    }> = []
  ): Promise<string> {
    try {
      console.log(
        "🤖 Invoking Perplexity agent with user message:",
        userMessage.substring(0, 200)
      );

      // Build user message content - can be string or array for multimodal
      let userContent: any = userMessage;
      let warningMessage = "";

      if (fileAttachments.length > 0) {
        // Check if model supports file attachments
        const fileEnabledModels = [
          "sonar-pro",
          "sonar-vision",
          "sonar-pro-vision",
          "llama-3.2-11b-vision-instruct",
          "llama-3.2-90b-vision-instruct",
        ];
        const supportsFiles = fileEnabledModels.some((vm) =>
          this.model.includes(vm)
        );

        if (!supportsFiles) {
          const warning = `⚠️ Note: The current model "${this.model}" does not support file attachments. Files were ignored. To enable file support, set PERPLEXITY_MODEL to "sonar-pro" in your .env file.`;
          console.warn(warning);
          warningMessage = warning + "\n\n";
          // Don't add files if model doesn't support them
        } else {
          console.log(
            `📎 Including ${fileAttachments.length} file(s) in request`
          );

          // Multimodal content: array of text and files
          userContent = [{ type: "text", text: userMessage }];

          fileAttachments.forEach((file, index) => {
            const dataUri = `data:${file.contentType};base64,${file.base64}`;
            console.log(`📄 File ${index + 1}:`, {
              name: file.name,
              contentType: file.contentType,
              base64Length: file.base64.length,
              dataUriLength: dataUri.length,
              dataUriPreview: dataUri.substring(0, 100) + "...",
            });

            userContent.push({
              type: "image_url",
              image_url: {
                url: dataUri,
              },
            });
          });
        }
      }

      console.log("📤 Sending to Perplexity:", {
        model: this.model,
        messageType: typeof userContent,
        isArray: Array.isArray(userContent),
        contentLength:
          typeof userContent === "string"
            ? userContent.length
            : userContent.length,
      });

      const response = await this.client.chat.completions.create({
        model: this.model, // e.g. "sonar" / "sonar-pro"
        messages: [
          {
            role: "system",
            content: this.systemPrompt,
          },
          { role: "user", content: userContent },
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
        return warningMessage + answer;
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

      return `${warningMessage}${answer.trim()}${formattedSources}`;
    } catch (error) {
      console.error("Perplexity agent error:", error);
      const err = error as any;
      return `Error: ${err?.message || String(err)}`;
    }
  }
}
