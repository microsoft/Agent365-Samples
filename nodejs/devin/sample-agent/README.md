# Sample Agent - Node.js Devin

This directory contains a sample agent implementation using Node.js and Devin API.

## Demonstrates

This sample demonstrates how to build an agent using the Microsoft Agent 365 SDK with Node.js and Devin API.

## Prerequisites

- Node.js 24+
- Devin API access
- Agents SDK

## How to run this sample

1. **Setup environment variables**

   ```bash
   # Copy the template environment file
   cp .env.example .env
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
   npm run start
   ```

5. **Start AgentsPlayground to chat with your agent**
   ```bash
   npm run test-tool
   ```

The agent will start and be ready to receive requests through the configured hosting mechanism.

## 📚 Related Documentation

- [Devin API Documentation](https://docs.devin.ai/api-reference/overview)
- [Microsoft Agent 365 SDK](https://github.com/microsoft/Agents-for-js)
- [AgentsPlayground](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/test-with-toolkit-project?tabs=windows)

## 🤝 Contributing

1. Follow the existing code patterns and structure
2. Add comprehensive logging and error handling
3. Update documentation for new features
4. Test thoroughly with different authentication methods

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](../../../LICENSE.md) file for details.
