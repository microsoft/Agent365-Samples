// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using work_iq_teams_bot.TeamsApp;
using Microsoft.Teams.Apps;

WebApplicationBuilder builder = WebApplication.CreateSlimBuilder(args);

builder.AddServiceDefaults();

builder.Services
    .AddWorkIQAgent(builder.Configuration)
    .AddTeamsBotApplication<WorkIQTeamsBotApp>();

WebApplication webApp = builder.Build();

webApp.MapDefaultEndpoints();
webApp.UseTeamsBotApplication<WorkIQTeamsBotApp>();
webApp.Run();
