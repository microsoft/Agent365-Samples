# CrewAgent Crew - Python

This sample demonstrates how to build a multi‑agent system using CrewAI while integrating with the Microsoft Agent 365 SDK. It mirrors the structure and hosting patterns of the AgentFramework/OpenAI Agent 365 samples, while preserving native CrewAI logic in src/crew_agent. It covers:

- **Observability**: End-to-end tracing, caching, and monitoring for agent applications
- **Notifications**: Services and models for managing user notifications
- **Tools**: Model Context Protocol tools for building advanced agent solutions
- **Hosting Patterns**: Hosting with Microsoft 365 Agents SDK

This sample uses the [Microsoft Agent 365 SDK for Python](https://github.com/microsoft/Agent365-python).

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Prerequisites

- Python 3.11+
- Microsoft Agent 365 SDK
- Azure/OpenAI API credentials
- UV (recommended for dependency management)

## Running the Agent

   ## Customizing
    - Add your `OPENAI_API_KEY` into `.env`.
    - Modify `src/crew_agent/config/agents.yaml` and `tasks.yaml`.
    - Edit `src/crew_agent/crew.py` and `src/crew_agent/main.py` for your logic.

   ## Running the Project

   ### Option 1: Run via Agent Runner
   ```bash
    python -m crew_agent.agent_runner "London"
    # or
    agent_runner "San Francisco, CA"
   ```

   ### Option 2: Hosted via Generic Agent Host with Agent 365 (Microsoft Agent365 SDK)
   Mirrors the OpenAI/AgentFramework samples and adds Agent 365 observability + MCP server registration.

   1) Copy `.env.template` to `.env` and fill:
      - `CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTID` / `CLIENTSECRET` / `TENANTID`
      - `AGENTAPPLICATION__USERAUTHORIZATION__HANDLERS__AGENTIC__SETTINGS__TYPE` / `SCOPES` (already in template)
      - `OBSERVABILITY_SERVICE_NAME` / `OBSERVABILITY_SERVICE_NAMESPACE`
      - Optional: `BEARER_TOKEN` if you want agentic auth via bearer
   2) Run host: `python start_with_generic_host.py`
   3) Health: `http://localhost:3978/api/health` (auto-fallback to next port if busy)
   4) Playground/Bot Framework endpoint: `http://localhost:3978/api/messages`
      - Message text is forwarded into your CrewAI flow as the `location` input.
      - MCP servers from the Agent 365 platform are discovered and passed to CrewAI agents (SSE transport with bearer headers).

   Agent 365 observability:
   - Configured via `microsoft_agents_a365.observability.core.configure` in `agent.py`
   - Agentic token is cached/resolved for the exporter (see `token_cache.py`)
   - Startup logs show a masked env snapshot

## Understanding Your Crew
1) **Weather Checker**: Uses web search (Tavily) to find current weather conditions  
2) **Driving Safety Advisor**: Assesses whether it's safe to drive an MX-5 with summer tires based on weather data

## Support

For issues, questions, or feedback:

- **CrewAI Documentation**: https://docs.crewai.com
- **CrewAI GitHub**: https://github.com/joaomdmoura/crewai
- **Microsoft Agent 365 Documentation:**: https://learn.microsoft.com/en-us/microsoft-agent-365/developer/
- **Discord**: https://discord.com/invite/X4JWnZnxPb

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Additional Resources

- [Microsoft Agent 365 SDK - Python repository](https://github.com/microsoft/Agent365-python)
- [Microsoft 365 Agents SDK - Python repository](https://github.com/Microsoft/Agents-for-python)
- [CrewAI API documentation](https://docs.crewai.com)
- [Python API documentation](https://learn.microsoft.com/python/api/?view=m365-agents-sdk&preserve-view=true)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](LICENSE.md) file for details.