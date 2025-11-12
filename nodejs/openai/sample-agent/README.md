# Sample Agent - Node.js OpenAI

This directory contains a sample agent implementation using Node.js and OpenAI.

## Demonstrates

This sample demonstrates how to build an agent using the Agent365 framework with Node.js and OpenAI.

## Prerequisites

- Node.js 18+
- OpenAI API access
- OpenAI Agents SDK
- Agents SDK

## How to run this sample

1. **Setup environment variables**
   ```bash
   # Copy the example environment file
   cp .env.example .env
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

The agent will start and be ready to receive requests through the configured hosting mechanism.