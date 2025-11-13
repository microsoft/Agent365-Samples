# Sample Agent - Node.js Claude

This directory contains a sample agent implementation using Node.js and Claude Agent SDK.

## Demonstrates

This sample demonstrates how to build an agent using the Microsoft Agent 365 SDK with Node.js and Claude Agent SDK.

## Prerequisites

- Node.js 18+
- Anthropic API access
- Claude Agent SDK
- Agents SDK

## How to run this sample

1. **Setup environment variables**
   ```bash
   # Copy the template environment file
   cp .env.template .env
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

   **Note** Be sure to create the folder `./packages/` and add the a365 packages here for the preinstall script to work.

3. **Build the project**
   ```bash
   npm run build
   ```

4. **Start the agent**
   ```bash
   npm start
   ```

5. **Optionally, while testing you can run in dev mode**
   ```bash
   npm run dev
   ```

6. **Start AgentsPlayground to chat with your agent**
   ```bash
   agentsplayground
   ```

The agent will start and be ready to receive requests through the configured hosting mechanism.

## Documentation

For detailed information about this sample, please refer to:

- **[AGENT-CODE-WALKTHROUGH.md](AGENT-CODE-WALKTHROUGH.md)** - Detailed code explanation and architecture walkthrough

## 📚 Related Documentation

- [Claude Agent SDK Documentation](https://docs.claude.com/en/docs/agent-sdk/typescript.md)
- [Microsoft Agent 365 Tooling](https://github.com/microsoft/Agent365-nodejs/tree/main/packages/agents-a365-tooling-extensions-claude)
- [Model Context Protocol (MCP)](https://github.com/modelcontextprotocol/typescript-sdk/tree/main)
- [AgentsPlayground](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/test-with-toolkit-project?tabs=windows)

## 🤝 Contributing

1. Follow the existing code patterns and structure
2. Add comprehensive logging and error handling
3. Update documentation for new features
4. Test thoroughly with different authentication methods

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](../../../LICENSE.md) file for details.
