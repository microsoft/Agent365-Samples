// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Microsoft.Teams.Apps;
//using Microsoft.Teams.Apps.Diagnostics;
//using Microsoft.Teams.Core.Diagnostics;
using work_iq_teams_bot.TeamsApp;

WebApplicationBuilder builder = WebApplication.CreateSlimBuilder(args);

//builder.AddServiceDefaults(
//    activitySources: [CoreTelemetryNames.ActivitySourceName, TeamsBotApplicationTelemetry.ActivitySourceName, "Experimental.Microsoft.Agents.AI", "ModelContextProtocol"],
//    meterNames: [CoreTelemetryNames.MeterName, TeamsBotApplicationTelemetry.MeterName, "Experimental.Microsoft.Agents.AI", "ModelContextProtocol"]);

builder.AddServiceDefaults(
    activitySources: [ "Experimental.Microsoft.Agents.AI", "ModelContextProtocol"],
    meterNames: [ "Experimental.Microsoft.Agents.AI", "ModelContextProtocol"]);

builder.Services
    .AddWorkIQAgent(builder.Configuration)
    .AddTeamsBotApplication<WorkIQTeamsBotApp>();

WebApplication webApp = builder.Build();

webApp.MapDefaultEndpoints();
webApp.UseTeamsBotApplication<WorkIQTeamsBotApp>();
webApp.Run();
