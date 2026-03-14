# Multiple Messages Per Prompt — Issue #268 Tracking

Tracking implementation of the multiple-messages pattern across all Agent365-Samples.

**Pattern**: Send an immediate ack message → typing indicator loop → LLM response, all as separate discrete Teams messages.

> **Reference**: [GitHub Issue #268](https://github.com/microsoft/Agent365-devTools/issues/268)

---

## Progress

| Sample | Implementation File | Code | README | Committed | Tested (Agents Playground) |
|---|---|---|---|---|---|
| `dotnet/agent-framework` | `Agent/MyAgent.cs` | ✅ | ✅ | ✅ | ✅ |
| `dotnet/semantic-kernel` | `Agents/MyAgent.cs` | 🔧 | 🔧 | ⏳ | ✅ |
| `python/agent-framework` | `host_agent_server.py` | 🔧 | 🔧 | ⏳ | ❌ Blocked — `agent_framework` SDK API break (`ChatAgent` removed); pre-existing env issue |
| `python/openai` | `host_agent_server.py` | 🔧 | 🔧 | ⏳ | ⏳ |
| `python/claude` | `host_agent_server.py` | 🔧 | 🔧 | ⏳ | ⏳ |
| `python/crewai` | `host_agent_server.py` | 🔧 | 🔧 | ⏳ | ⏳ |
| `python/google-adk` | `hosting.py` | 🔧 | 🔧 | ⏳ | ⏳ |
| `nodejs/openai` | `src/agent.ts` | 🔧 | 🔧 | ⏳ | ✅ |
| `nodejs/claude` | `src/agent.ts` | 🔧 | 🔧 | ⏳ | ⏳ Needs ANTHROPIC_API_KEY |
| `nodejs/langchain` | `src/agent.ts` | 🔧 | 🔧 | ⏳ | ⏳ |
| `nodejs/langchain/quickstart-before` | `src/agent.ts` | 🔧 | 🔧 | ⏳ | ✅ |
| `nodejs/vercel-sdk` | `src/agent.ts` | 🔧 | 🔧 | ⏳ | ⏳ Needs ANTHROPIC_API_KEY |
| `nodejs/devin` | `src/agent.ts` | 🔧 | 🔧 | ⏳ | ⏳ Needs Devin credentials |
| `nodejs/perplexity` | `src/agent.ts` | 🔧 | 🔧 | ⏳ | ⏳ Needs PERPLEXITY_API_KEY |
| `nodejs/copilot-studio` | `src/agent.ts` | 🔧 | 🔧 | ⏳ | ⏳ |

**Legend**: ✅ Done · 🔧 Modified locally, not committed · ⏳ Pending

---

## Notes

- `python/google-adk` uses a different hosting pattern — `MyAgent(AgentApplication)` class in `hosting.py` rather than `host_agent_server.py`. Pattern applied to `message_handler` directly.
- `nodejs/copilot-studio` was missing the `InstallationUpdate` handler in the constructor — added as part of this work.
- `nodejs/langchain/quickstart-before` is a pre-refactor snapshot — fixed pre-existing TypeScript errors (`instructions` → `systemPrompt` for langchain 1.2.32+, added `@types/express`/`@types/node`).
- Node.js samples use a manual `setInterval` typing loop (~4s) even though `startTypingTimer: true` is set in the constructor. The manual loop is necessary for long-running LLM calls that exceed the ~5s typing indicator timeout.
- Python samples use `asyncio.create_task` for the typing loop since all aiohttp handlers run on the same event loop.
- C# (`dotnet/semantic-kernel`) uses a single typing indicator (no loop) sent before agent initialization; the streaming informative update takes over as the progress indicator once the LLM call starts. Unlike agent-framework which runs a full `Task.Run` typing loop alongside streaming.
