# Cursor IDE Prompt Guide

## 1. Introduction
This guide explains how to use Cursor IDE to create a Microsoft Agent 365 agent by providing a natural language prompt. For illustration, we use **TypeScript with Claude as the orchestrator** and an **email management use case**, but the same approach works for other languages, orchestrators, and scenarios (calendar management, document search, etc.).

You will:
- Reference Microsoft Learn documentation URLs that describe Agent 365 concepts, tooling, and integration patterns.
- Send one concise prompt to Cursor (including documentation URLs) so it scaffolds the project for you.
- Know where to look for the generated README files and next steps.

## 2. Prerequisites
Before you begin, make sure you have:
- **[Cursor IDE](https://cursor.com/)** installed and a Cursor account (free or pro).
- **[Node.js 18+](https://nodejs.org/)** installed (for running the TypeScript project Cursor will generate). Verify with `node --version`.
- **[Anthropic (Claude) API key](https://console.anthropic.com/)** - Sign up at console.anthropic.com and retrieve your API key.
- An idea of the use case you want the agent to support—in this example, summarizing and replying to unread emails.

## 3. Gather References
Cursor works best when you reference Microsoft Learn documentation directly in your prompt. You'll include these URLs in your prompt (Section 4), and Cursor will fetch and analyze them in real-time.

When crafting your prompt, reference these Microsoft Learn pages by URL. Cursor will read them when you submit your prompt:

- **Agent 365 Developer Overview**: https://learn.microsoft.com/en-us/microsoft-agent-365/developer/?tabs=nodejs
- **Notifications**: https://learn.microsoft.com/en-us/microsoft-agent-365/developer/notification?tabs=nodejs  
- **Tooling (MCP)**: https://learn.microsoft.com/en-us/microsoft-agent-365/developer/tooling?tabs=nodejs
- **Observability**: https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability?tabs=nodejs
- **Node.js + Claude Quickstart**: https://learn.microsoft.com/en-us/microsoft-agent-365/developer/quickstart-nodejs-claude

## 4. Prompting Cursor
Open the Composer and paste a prompt like this, including the Microsoft Learn documentation URLs:

```
Using these documentations:
https://learn.microsoft.com/en-us/microsoft-agent-365/developer/?tabs=nodejs
https://learn.microsoft.com/en-us/microsoft-agent-365/developer/notification?tabs=nodejs
https://learn.microsoft.com/en-us/microsoft-agent-365/developer/tooling?tabs=nodejs
https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability?tabs=nodejs
https://learn.microsoft.com/en-us/microsoft-agent-365/developer/quickstart-nodejs-claude

Create a Microsoft Agent 365 agent in TypeScript with Claude as the orchestrator that can summarize unread emails and draft helpful email responses. The agent must:
- Receive a user message
- Forward it to Claude
- Return Claude's response
- Add basic inbound/outbound observability traces
- Integrate tooling support (specifically MailTools for email operations)
Produce the code, config files, and README needed to run it with Node.js/TypeScript.
```

**Note:** You can adapt this prompt for other use cases—replace "summarize unread emails" with "manage calendar events," "search SharePoint documents," or other Microsoft 365 operations. Just mention the relevant tools (CalendarTools, SharePointTools, etc.) in the requirements. If it misses something—like tooling registration or observability—send a quick follow-up instruction to regenerate the affected files.

### 4.1 Plan Mode in Cursor
If you want Cursor to show a plan before generating code, switch the Composer into **Plan Mode** (click the lightning icon or toggle labeled “Plan”). After you submit the prompt, Cursor will propose a plan outlining the changes it intends to make. Review it carefully—if it matches your expectations, click **Build** to proceed. You can always edit the plan to suit your requirements.

## 5. Running the Prompt in Cursor
1. Open Cursor and create a new workspace (or use your existing project folder).
2. Open the Composer (click the pencil icon or press `Cmd/Ctrl+L`).
3. Paste the prompt from Section 4 (including the documentation URLs) and submit.
4. Review the generated TypeScript files. Cursor highlights every change so you can confirm the structure looks right.
5. If you need tweaks, send a follow-up instruction (e.g., "Regenerate src/agent.ts with more logging" or "Include a Node.js Express server entry point").
6. The files are generated directly in your workspace folder and ready to use.

## 6. After Prompt Generation
1. **Read the generated README:** Cursor creates a README with prerequisites, configuration, 
   and run commands specific to your agent.
2. **Configure environment variables:** 
   - Look for `.env.example`, `.env.template`, or configuration instructions in the README.
   - Copy to `.env` and fill in required values (API keys, endpoints, etc.).
3. **Open a terminal in Cursor:**
   - Menu: Terminal → New Terminal (or Ctrl+`)
   - Navigate to your project folder
4. **Install dependencies and run:**
   ```bash
   npm install    # Install dependencies
   npm run build  # Build TypeScript (if needed)
   npm start      # Start the agent
   ```
5. **Test the agent:** Follow testing instructions in the generated README.

## 7. Adapting the Prompt
- **Different use case:** This is the most common customization. Replace "summarize unread emails" with your desired functionality:
  - **Calendar management:** "manage calendar events, schedule meetings, and find available time slots" (use CalendarTools)
  - **Document search:** "search SharePoint documents and summarize findings" (use SharePointTools)
  - Mention the relevant tools in the requirements (e.g., "specifically CalendarTools for calendar operations").
- **Different orchestrator:** Replace "Claude" with another provider (e.g., "OpenAI GPT-4") and update the documentation URLs to match.
- **Different language:** If you want Python, C#, etc., adjust the prompt and documentation URLs accordingly (change `?tabs=nodejs` to `?tabs=python` or `?tabs=dotnet`). The rest of this guide still applies, but ensure your environment is aligned with that stack.
- **More or less guidance:** Add a sentence if you need something specific (e.g., "Use Express server hosting" or "Skip observability").


By combining Microsoft Learn documentation with this minimal prompt, Cursor can scaffold a Microsoft Agent 365 project quickly.


## Learn More
**Getting Started with Cursor**: <https://cursor.com/docs/get-started/concepts>
