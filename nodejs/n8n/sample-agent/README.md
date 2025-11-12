# n8n Agent

A Microsoft Agent 365 that integrates with n8n workflows for AI-powered automation.

## Demonstrates

This agent receives messages from Microsoft 365 (Teams, email, Word comments) and forwards them to an n8n workflow via webhook. The n8n workflow processes the request and returns a response.

## Prerequisites

- Node.js 18+
- n8n instance with webhook endpoint
- Agentic Authentication registration

## How to run this sample

1. **Configure n8n webhook:**
   - Create a workflow in n8n with a webhook trigger
   - Configure the webhook to accept POST requests
   - The webhook should expect a JSON body with `text`, `from`, `type`, and optional `mcpServers` fields
   - Return a JSON response with an `output` field containing the response text

1. **Set environment variables:**
   Copy `.env.example` to `.env` and configure:

   ```bash
   cp .env.example .env
   ```

1. **Install dependencies**
   ```bash
   npm install
   ```

1. **Build the project**
   ```bash
   npm run build
   ```

1. **Start the agent**
   ```bash
   npm start
   ```

1. **Optionally, while testing you can run in dev mode**
   ```bash
   npm run dev
   ```

1. **Optionally, for testing you can use the Agents Playground:**
   ```bash
   # Launch Agents Playground for testing
   npm run test-tool
   ```
