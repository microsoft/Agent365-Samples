# Sample Agent - Node.js LangChain

This directory contains a quickstart agent implementation using Node.js and LangChain.

## Demonstrates

This sample is used to demonstrate how to build an agent using the Agent365 framework with Node.js and LangChain. The sample includes basic LangChain Agent SDK usage hosted with Agents SDK that is testable on [agentsplayground](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/test-with-toolkit-project?tabs=windows).
Please refer to this [quickstart guide](https://review.learn.microsoft.com/en-us/microsoft-agent-365/developer/quickstart-nodejs-langchain?branch=main) on how to extend your agent using Agent365 SDK.

## Prerequisites

- Node.js 18+
- LangChain
- Agents SDK

## How to run this sample

1. **Setup environment variables**
   ```bash
   # Copy the example environment file
   cp .env.template .env
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

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

- [LangChain Agent SDK Documentation](https://docs.langchain.com/oss/javascript/langchain/overview)
- [Microsoft 365 Agents SDK](https://github.com/microsoft/Agents-for-js/tree/main)
- [Model Context Protocol (MCP)](https://github.com/modelcontextprotocol/typescript-sdk/tree/main)

## 🤝 Contributing

1. Follow the existing code patterns and structure
2. Add comprehensive logging and error handling
3. Update documentation for new features
4. Test thoroughly with different authentication methods

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](../../../LICENSE.md) file for details.