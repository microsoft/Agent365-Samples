// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Microsoft.Teams.Apps;
using Microsoft.Teams.Apps.Api.Clients;
using Microsoft.Teams.Apps.Handlers;
using Microsoft.Teams.Apps.Schema;
using Microsoft.Teams.Core;
using Microsoft.Teams.Core.Hosting;

namespace work_iq_teams_bot.TeamsApp;

/// <summary>
/// Custom <see cref="TeamsBotApplication"/> for the A365 MCP sample. Registers the
/// inbound message handler in its constructor and resolves a fresh <see cref="WorkIQAgent"/>
/// from a per-turn DI scope so scoped services (and any future scoped dependencies of
/// <see cref="WorkIQAgent"/>) are honored correctly.
/// </summary>
internal sealed class WorkIQTeamsBotApp : TeamsBotApplication
{
    private readonly IServiceScopeFactory _scopeFactory;

    public WorkIQTeamsBotApp(
        ConversationClient conversationClient,
        UserTokenClient userTokenClient,
        ApiClient teamsApiClient,
        IHttpContextAccessor httpContextAccessor,
        ILogger<TeamsBotApplication> logger,
        IServiceScopeFactory scopeFactory,
        BotApplicationOptions? options = null,
        TeamsBotApplicationOptions? teamsOptions = null)
        : base(conversationClient, userTokenClient, teamsApiClient, httpContextAccessor, logger, options, teamsOptions)
    {
        _scopeFactory = scopeFactory;

        this.OnMessage(HandleMessageAsync);
    }

    private async Task HandleMessageAsync(Context<MessageActivity> context, CancellationToken cancellationToken)
    {
        await context.SendTypingActivityAsync(cancellationToken);

        string userText = context.Activity.TextWithoutMentions ?? string.Empty;

        // Resolve Agent from a fresh per-turn scope so scoped services have a well-defined lifetime
        // independent of the singleton bot application and of any ambient HTTP request scope.
        await using AsyncServiceScope scope = _scopeFactory.CreateAsyncScope();
        WorkIQAgent agent = scope.ServiceProvider.GetRequiredService<WorkIQAgent>();

        string response = await agent.RunAsync(
            context.Activity,
            cancellationToken);

        TeamsActivity reply = TeamsActivity.CreateBuilder()
            .WithText(response, TextFormats.Markdown)
            .Build();

        await context.SendActivityAsync(reply, cancellationToken);
    }
}
