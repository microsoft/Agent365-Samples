// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using DotNetAutonomous.Tools;
using Microsoft.Agents.AI;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App;
using Microsoft.Agents.Builder.State;
using Microsoft.Agents.Core;
using Microsoft.Agents.Core.Models;
using Microsoft.Agents.Core.Serialization;
using Microsoft.Extensions.AI;
using System.Text.Json;

namespace DotNetAutonomous.Agent;

public class DotNetAutonomousAgent : AgentApplication
{
    private const string SystemPrompt =
        "You are a helpful weather operations assistant. " +
        "You can look up current weather conditions for any city worldwide. " +
        "When asked about weather, always use the GetCurrentWeather tool to fetch live data. " +
        "Never say you are an AI or language model.";

    private readonly ILogger<DotNetAutonomousAgent> _logger;
    private readonly IChatClient _chatClient;
    private readonly WeatherLookupTool _weatherTool;

    public DotNetAutonomousAgent(
        AgentApplicationOptions options,
        IChatClient chatClient,
        WeatherLookupTool weatherTool,
        ILogger<DotNetAutonomousAgent> logger) : base(options)
    {
        _logger = logger;
        _chatClient = chatClient;
        _weatherTool = weatherTool;

        OnConversationUpdate(ConversationUpdateEvents.MembersAdded, OnMembersAddedAsync);

        OnActivity(ActivityTypes.InstallationUpdate, OnInstallationUpdateAsync, isAgenticOnly: true);

        OnActivity(ActivityTypes.Message, OnMessageAsync, isAgenticOnly: true);
        OnActivity(ActivityTypes.Message, OnMessageAsync, isAgenticOnly: false);
    }

    private async Task OnMembersAddedAsync(ITurnContext tc, ITurnState ts, CancellationToken ct)
    {
        foreach (var member in tc.Activity.MembersAdded)
        {
            if (member.Id != tc.Activity.Recipient.Id)
            {
                await tc.SendActivityAsync(
                    MessageFactory.Text("Hello! I am your weather operations assistant. Ask me about weather conditions in any city!"),
                    ct);
            }
        }
    }

    private async Task OnInstallationUpdateAsync(ITurnContext tc, ITurnState ts, CancellationToken ct)
    {
        _logger.LogInformation(
            "InstallationUpdate — Action: '{Action}', From: '{Name}'",
            tc.Activity.Action ?? "(none)",
            tc.Activity.From?.Name ?? "(unknown)");

        if (tc.Activity.Action == InstallationUpdateActionTypes.Add)
            await tc.SendActivityAsync(MessageFactory.Text("Agent installed successfully."), ct);
        else if (tc.Activity.Action == InstallationUpdateActionTypes.Remove)
            await tc.SendActivityAsync(MessageFactory.Text("Agent uninstalled."), ct);
    }

    private async Task OnMessageAsync(ITurnContext tc, ITurnState ts, CancellationToken ct)
    {
        var text = tc.Activity.Text?.Trim() ?? string.Empty;

        _logger.LogInformation(
            "Message received — From: '{Name}', Text: '{Text}'",
            tc.Activity.From?.Name ?? "(unknown)",
            text);

        // Immediate UX feedback before the LLM call starts
        await tc.SendActivityAsync(Activity.CreateTypingActivity(), ct).ConfigureAwait(false);
        await tc.StreamingResponse.QueueInformativeUpdateAsync("Working on it…").ConfigureAwait(false);

        // Background loop refreshes the typing indicator every 4s (it times out after ~5s)
        using var typingCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var typingTask = Task.Run(async () =>
        {
            try
            {
                while (!typingCts.IsCancellationRequested)
                {
                    await Task.Delay(TimeSpan.FromSeconds(4), typingCts.Token).ConfigureAwait(false);
                    await tc.SendActivityAsync(Activity.CreateTypingActivity(), typingCts.Token).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) { }
        }, typingCts.Token);

        try
        {
            var agent = BuildAgent();
            var thread = GetOrCreateThread(agent, ts);

            await foreach (var response in agent.RunStreamingAsync(text, thread, cancellationToken: ct))
            {
                if (response.Role == ChatRole.Assistant && !string.IsNullOrEmpty(response.Text))
                    tc.StreamingResponse.QueueTextChunk(response.Text);
            }

            ts.Conversation.SetValue("conversation.threadInfo", ProtocolJsonSerializer.ToJson(thread.Serialize()));
        }
        finally
        {
            typingCts.Cancel();
            try { await typingTask.ConfigureAwait(false); }
            catch (OperationCanceledException) { }
            await tc.StreamingResponse.EndStreamAsync(ct).ConfigureAwait(false);
        }
    }

    private AIAgent BuildAgent()
    {
        var tools = new List<AITool>
        {
            AIFunctionFactory.Create(_weatherTool.GetCurrentWeather)
        };

        return new ChatClientAgent(_chatClient, new ChatClientAgentOptions
        {
            Instructions = SystemPrompt,
            ChatOptions = new ChatOptions { Temperature = 0.2f, Tools = tools },
            ChatMessageStoreFactory = ctx =>
            {
#pragma warning disable MEAI001
                return new InMemoryChatMessageStore(new MessageCountingChatReducer(10), ctx.SerializedState, ctx.JsonSerializerOptions);
#pragma warning restore MEAI001
            }
        })
        .AsBuilder()
        .Build();
    }

    private static AgentThread GetOrCreateThread(AIAgent agent, ITurnState ts)
    {
        var serialized = ts.Conversation.GetValue<string?>("conversation.threadInfo", () => null);
        if (string.IsNullOrEmpty(serialized))
            return agent.GetNewThread();

        var element = ProtocolJsonSerializer.ToObject<JsonElement>(serialized);
        return agent.DeserializeThread(element);
    }
}
