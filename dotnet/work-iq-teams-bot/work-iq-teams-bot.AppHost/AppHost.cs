// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

var builder = DistributedApplication.CreateBuilder(args);

builder.AddProject<Projects.work_iq_teams_bot_TeamsApp>("teamsbotapp")
    .WithHttpHealthCheck("/health");

builder.Build().Run();
