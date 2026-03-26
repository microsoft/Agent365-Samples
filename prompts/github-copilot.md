# GitHub Copilot Prompt Guide

## 1. Introduction
This guide explains how to use GitHub Copilot in Visual Studio Code to create a Microsoft Agent 365 agent by providing a natural language prompt. For illustration, we use **TypeScript with OpenAI GPT-5.4 as the model** and an **email management use case**, but the same approach works for other languages, models, and scenarios (calendar management, document search, etc.).

You will:
- Reference Microsoft Learn documentation URLs that describe Agent 365 concepts, tooling, and integration patterns.
- Send one concise prompt to GitHub Copilot (including documentation URLs) so it scaffolds the project for you.
- Know where to look for the generated README files and next steps.

## 2. Prerequisites
Before you begin, make sure you have:
- **[Visual Studio Code](https://code.visualstudio.com/)** installed.
- **[GitHub Copilot](https://github.com/features/copilot)** enabled for your GitHub account and available in VS Code.
- **[Node.js 18+](https://nodejs.org/)** installed (for running the TypeScript project Copilot will generate). Verify with `node --version`.
- API credentials for the model provider you plan to use (for example, OpenAI or Azure OpenAI), if required by the generated sample.
- An idea of the use case you want the agent to support—in this example, summarizing and replying to unread emails.

## 3. Gather References
GitHub Copilot works best when you reference Microsoft Learn documentation directly in your prompt. You'll include these URLs in your prompt (Section 4) so Copilot can use them as implementation guidance while generating the project.

When crafting your prompt, reference these Microsoft Learn pages by URL:

- **Agent 365 Developer Overview**: https://learn.microsoft.com/en-us/microsoft-agent-365/developer/?tabs=nodejs
- **Notifications**: https://learn.microsoft.com/en-us/microsoft-agent-365/developer/notification?tabs=nodejs
- **Tooling (MCP)**: https://learn.microsoft.com/en-us/microsoft-agent-365/developer/tooling?tabs=nodejs
- **Observability**: https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability?tabs=nodejs


## 4. Prompting GitHub Copilot
Open GitHub Copilot Chat in VS Code and paste a prompt like this, including the Microsoft Learn documentation URLs:

```
Using these documentation articles:
https://learn.microsoft.com/en-us/microsoft-agent-365/developer/?tabs=nodejs
https://learn.microsoft.com/en-us/microsoft-agent-365/developer/notification?tabs=nodejs
https://learn.microsoft.com/en-us/microsoft-agent-365/developer/tooling?tabs=nodejs
https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability?tabs=nodejs


Create a Microsoft Agent 365 agent in TypeScript using OpenAI GPT-5.4 that can summarize unread emails and draft helpful email responses. The agent must:
- Receive a user message
- Forward it to GPT-5.4
- Return the model's response
- Add basic inbound/outbound observability traces
- Integrate tooling support (specifically MailTools for email operations)
Produce the code, config files, and README needed to run it with Node.js/TypeScript.
```

**Note:** You can adapt this prompt for other use cases—replace "summarize unread emails" with "manage calendar events," "search SharePoint documents," or other Microsoft 365 operations. Just mention the relevant tools (CalendarTools, SharePointTools, etc.) in the requirements. If it misses something—like tooling registration or observability—send a quick follow-up instruction to regenerate the affected files.

### 4.1 Using Ask Mode and Agent Mode
If you want GitHub Copilot to think through the work before making edits, start in **Ask** mode and request a plan for the files it intends to create or update. Once the plan looks right, switch to **Agent** mode (or use the edit workflow available in your version of VS Code) and ask Copilot to generate the project files in your workspace.

Agent mode is the best fit when you want Copilot to create multiple files, update configuration, and wire the project together from a single prompt. Review the proposed edits before accepting them.

## 5. Running the Prompt in VS Code
1. Open VS Code and create a new workspace (or use your existing project folder).
2. Open the GitHub Copilot Chat panel.
3. If available, switch to **Agent** mode for multi-file generation. Otherwise, use chat/edit mode and let Copilot apply the changes step by step.
4. Paste the prompt from Section 4 (including the documentation URLs) and submit.
5. Review the generated TypeScript files. Copilot will show proposed edits so you can confirm the structure looks right before accepting them.
6. If you need tweaks, send a follow-up instruction (for example, "Regenerate `src/agent.ts` with more logging" or "Include a Node.js Express server entry point").
7. Accept the changes into your workspace when they match your expectations.

## 6. After Prompt Generation
1. **Read the generated README:** Copilot should create a README with prerequisites, configuration, and run commands specific to your agent.
2. **Configure environment variables:**
   - Look for `.env.example`, `.env.template`, or configuration instructions in the README.
   - Copy to `.env` and fill in required values (API keys, endpoints, etc.).
3. **Open a terminal in VS Code:**
   - Menu: Terminal -> New Terminal
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
  - Mention the relevant tools in the requirements (for example, "specifically CalendarTools for calendar operations").
- **Different model:** Replace "OpenAI GPT-5.4" with your preferred model or provider and adjust any configuration instructions accordingly.
- **Different language:** If you want Python, C#, etc., adjust the prompt and documentation URLs accordingly (change `?tabs=nodejs` to `?tabs=python` or `?tabs=dotnet`). The rest of this guide still applies, but ensure your environment is aligned with that stack.
- **More or less guidance:** Add a sentence if you need something specific (for example, "Use Express server hosting" or "Skip observability").

By combining Microsoft Learn documentation with this minimal prompt, GitHub Copilot can scaffold a Microsoft Agent 365 project quickly in VS Code.

## Learn More
- **GitHub Copilot for VS Code**: <https://code.visualstudio.com/docs/copilot/overview>
- **GitHub Copilot Chat**: <https://docs.github.com/copilot/using-github-copilot/asking-github-copilot-questions-in-your-ide>
