// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Text.RegularExpressions;
using Xunit;
using Microsoft.Agents.A365.Observability.Hosting.Caching;
using Microsoft.Agents.A365.Observability.Runtime.Tracing.Exporters;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using W365ComputerUseSample.Telemetry;

namespace W365ComputerUseSample.Tests;

public sealed class ObservabilityMigrationTests
{
    [Fact]
    public void ProgramUsesMicrosoftOpenTelemetryDistroWithCustomSignals()
    {
        var program = ReadRepoFile("sample-agent", "Program.cs");
        var observabilitySetup = ReadRepoFile("sample-agent", "Telemetry", "ObservabilityServiceCollectionExtensions.cs");

        Assert.Contains("builder.Services.AddW365ComputerUseOpenTelemetry(builder.Configuration);", program);
        Assert.Contains("services.AddOpenTelemetry()", observabilitySetup);
        Assert.Contains(".UseMicrosoftOpenTelemetry(options =>", observabilitySetup);
        Assert.Contains("options.Exporters = ExportTarget.Agent365;", observabilitySetup);
        Assert.Contains("configuration.GetValue<bool>(\"EnableOpenTelemetryConsoleExporter\")", observabilitySetup);
        Assert.Contains("options.Exporters |= ExportTarget.Console;", observabilitySetup);
        Assert.Contains("options.Agent365.ClusterCategory = \"production\";", observabilitySetup);
        Assert.Contains(".AddSource(AgentMetrics.SourceName)", observabilitySetup);
        Assert.Contains(".AddMeter(AgentMetrics.SourceName)", observabilitySetup);
        Assert.Contains("var agenticTokenCache = new AgenticTokenCache();", observabilitySetup);
        Assert.Contains("var serviceTokenCache = new ServiceTokenCache();", observabilitySetup);
        Assert.Contains("services.AddSingleton<IExporterTokenCache<AgenticTokenStruct>>(agenticTokenCache);", observabilitySetup);
        Assert.Contains("services.AddSingleton(serviceTokenCache);", observabilitySetup);
        Assert.Contains("options.Agent365.TokenResolver = serviceTokenCache.GetObservabilityToken;", observabilitySetup);

        Assert.DoesNotContain("Configure" + "OpenTelemetry()", program);
        Assert.DoesNotContain("AddAgentic" + "TracingExporter", program);
        Assert.DoesNotContain("Add" + "A365Tracing", program);
        Assert.DoesNotContain("Configure" + "OpenTelemetry()", observabilitySetup);
        Assert.DoesNotContain("AddAgentic" + "TracingExporter", observabilitySetup);
        Assert.DoesNotContain("Add" + "A365Tracing", observabilitySetup);
    }

    [Fact]
    public void ProjectUsesDistroPackageWithoutLegacyObservabilityReferences()
    {
        var project = ReadRepoFile("sample-agent", "W365ComputerUseSample.csproj");

        Assert.Contains("<PackageReference Include=\"Microsoft.OpenTelemetry\" Version=\"1.0.6\" />", project);
        Assert.DoesNotContain("Microsoft.Agents.A365.Observability.Extensions." + "AgentFramework", project);
        Assert.DoesNotContain("OpenTelemetry.Exporter." + "OpenTelemetryProtocol", project);
        Assert.DoesNotContain("OpenTelemetry.Extensions." + "Hosting", project);
        Assert.DoesNotContain("OpenTelemetry.Instrumentation." + "AspNetCore", project);
        Assert.DoesNotContain("OpenTelemetry.Instrumentation." + "Http", project);
        Assert.DoesNotContain("OpenTelemetry.Instrumentation." + "Runtime", project);
    }

    [Fact]
    public void TokenCacheReferencesUseDistroNamespace()
    {
        var agent = ReadRepoFile("sample-agent", "Agent", "MyAgent.cs");
        var wrapper = ReadRepoFile("sample-agent", "Telemetry", "A365OtelWrapper.cs");

        Assert.Contains("using Microsoft.Agents.A365.Observability.Hosting.Caching;", agent);
        Assert.Contains("using Microsoft.Agents.A365.Observability.Hosting.Caching;", wrapper);
        Assert.DoesNotContain("using Microsoft.Agents.A365.Observability.Caching;", agent);
        Assert.DoesNotContain("using Microsoft.Agents.A365.Observability.Caching;", wrapper);
    }

    [Fact]
    public void ObsoleteServiceExtensionsFileIsRemoved()
    {
        var serviceExtensionsPath = Path.Combine(FindRepositoryRoot(), "sample-agent", "ServiceExtensions.cs");

        Assert.False(File.Exists(serviceExtensionsPath), "ServiceExtensions.cs only contained the old OpenTelemetry setup and should be removed.");
    }

    [Fact]
    public void ObservabilitySetupRegistersAgent365TokenCacheAndResolver()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        var configuration = new ConfigurationBuilder().Build();

        services.AddW365ComputerUseOpenTelemetry(configuration);

        using var provider = services.BuildServiceProvider();
        Assert.IsType<AgenticTokenCache>(provider.GetRequiredService<IExporterTokenCache<AgenticTokenStruct>>());
        Assert.Same(
            provider.GetRequiredService<ServiceTokenCache>(),
            provider.GetRequiredService<ServiceTokenCache>());

        var exporterOptions = provider.GetRequiredService<IOptions<Agent365ExporterOptions>>().Value;
        Assert.NotNull(exporterOptions.TokenResolver);
        Assert.Equal("production", exporterOptions.ClusterCategory);
    }

    [Fact]
    public async Task ObservabilitySetupStartsOpenTelemetryHostedService()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        var configuration = new ConfigurationBuilder().Build();

        services.AddW365ComputerUseOpenTelemetry(configuration);

        await using var provider = services.BuildServiceProvider();
        foreach (var hostedService in provider.GetServices<IHostedService>())
        {
            await hostedService.StartAsync(CancellationToken.None);
            await hostedService.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public void AgentOperationObservabilityUsesAutoScopeMiddleware()
    {
        var wrapper = ReadRepoFile("sample-agent", "Telemetry", "A365OtelWrapper.cs");
        var program = ReadRepoFile("sample-agent", "Program.cs");

        Assert.Contains("using Microsoft.Agents.A365.Observability.Hosting.Middleware;", program);
        Assert.Contains("builder.Services.AddSingleton<BaggageTurnMiddleware>();", program);
        Assert.Contains("builder.Services.AddSingleton<OutputLoggingMiddleware>();", program);
        Assert.Contains("builder.Services.AddSingleton<Microsoft.Agents.Builder.IMiddleware[]>", program);

        var agent = ReadRepoFile("sample-agent", "Agent", "MyAgent.cs");
        Assert.Contains("A365OtelWrapper.InvokeObservedAgentOperation(", agent);
        Assert.DoesNotContain("_configuration", agent);

        Assert.Contains("Func<Task> func", wrapper);
        Assert.Contains("AgentMetrics.InvokeObservedAgentOperation(", wrapper);
        Assert.Contains("outputMessage = await func().ConfigureAwait(false);", wrapper);
        Assert.Contains("InvokeAgentScope.Start(", wrapper);
        Assert.Contains("RecordInvokeAgentOutputMessage(invokeAgentScope, outputMessage);", wrapper);
        Assert.Contains("ForceInvokeAgentServerPortTag(invokeAgentScope, telemetryContext);", wrapper);
    }

    [Fact]
    public void AgentOperationBaggageIsActiveBeforeCustomActivityStarts()
    {
        var wrapper = ReadRepoFile("sample-agent", "Telemetry", "A365OtelWrapper.cs");

        var resolveIndex = wrapper.IndexOf("ResolveTenantAndAgentId", StringComparison.Ordinal);
        var contextIndex = wrapper.IndexOf("Agent365TelemetryContext.FromTurnContext(", StringComparison.Ordinal);
        var baggageIndex = wrapper.IndexOf("using var baggageScope = telemetryContext.BuildBaggageScope();", StringComparison.Ordinal);
        var registerIndex = wrapper.IndexOf("serviceTokenCache?.RegisterObservability(", StringComparison.Ordinal);
        var invokeScopeIndex = wrapper.IndexOf("using var invokeAgentScope = StartInvokeAgentScope(turnContext, telemetryContext);", StringComparison.Ordinal);
        var activityIndex = wrapper.IndexOf("AgentMetrics.InvokeObservedAgentOperation", StringComparison.Ordinal);

        Assert.True(resolveIndex >= 0, "The wrapper should resolve agent and tenant identity before building the telemetry context.");
        Assert.True(contextIndex >= 0, "The wrapper should build the full Admin Center telemetry context before starting scopes.");
        Assert.True(baggageIndex >= 0, "The wrapper should create A365 baggage from the shared telemetry context.");
        Assert.True(registerIndex >= 0, "The wrapper should register observability before exporting spans for the identity.");
        Assert.True(invokeScopeIndex >= 0, "The wrapper should start InvokeAgentScope from the shared telemetry context.");
        Assert.True(activityIndex >= 0, "The wrapper should still create the custom observed activity.");
        Assert.True(resolveIndex < contextIndex, "Identity must be resolved before building the telemetry context.");
        Assert.True(contextIndex < baggageIndex, "The telemetry context must be built before baggage scope starts.");
        Assert.True(baggageIndex < registerIndex, "Baggage must be active before token registration can export.");
        Assert.True(baggageIndex < invokeScopeIndex, "Baggage must be active before InvokeAgentScope starts.");
        Assert.True(registerIndex < invokeScopeIndex, "The token cache should be registered before InvokeAgentScope starts.");
        Assert.True(invokeScopeIndex < activityIndex, "InvokeAgentScope should wrap the custom MessageProcessor activity.");
    }

    [Fact]
    public void AgentOperationBuildsFullAdminCenterTelemetryContextBeforeScopes()
    {
        var wrapper = ReadRepoFile("sample-agent", "Telemetry", "A365OtelWrapper.cs");
        var context = ReadRepoFile("sample-agent", "Telemetry", "Agent365TelemetryContext.cs");
        var options = ReadRepoFile("sample-agent", "Telemetry", "Agent365TelemetryOptions.cs");
        var agent = ReadRepoFile("sample-agent", "Agent", "MyAgent.cs");
        var program = ReadRepoFile("sample-agent", "Program.cs");

        Assert.Contains("builder.Services.Configure<Agent365TelemetryOptions>", program);
        Assert.Contains("IOptions<Agent365TelemetryOptions> agent365TelemetryOptions", agent);
        Assert.Contains("_agent365TelemetryOptions", agent);
        Assert.Contains("Agent365TelemetryOptions? telemetryOptions", wrapper);
        Assert.Contains("Agent365TelemetryContext.FromTurnContext(", wrapper);
        Assert.Contains("using var baggageScope = telemetryContext.BuildBaggageScope();", wrapper);
        Assert.Contains("using var invokeAgentScope = StartInvokeAgentScope(turnContext, telemetryContext);", wrapper);

        var contextIndex = wrapper.IndexOf("Agent365TelemetryContext.FromTurnContext(", StringComparison.Ordinal);
        var baggageIndex = wrapper.IndexOf("using var baggageScope = telemetryContext.BuildBaggageScope();", StringComparison.Ordinal);
        var tokenRegisterIndex = wrapper.IndexOf("serviceTokenCache?.RegisterObservability(", StringComparison.Ordinal);
        var invokeScopeIndex = wrapper.IndexOf("using var invokeAgentScope = StartInvokeAgentScope(turnContext, telemetryContext);", StringComparison.Ordinal);
        var activityIndex = wrapper.IndexOf("AgentMetrics.InvokeObservedAgentOperation", StringComparison.Ordinal);
        Assert.True(contextIndex >= 0, "The wrapper should build the full Admin Center telemetry context.");
        Assert.True(baggageIndex >= 0, "The wrapper should create baggage from the telemetry context.");
        Assert.True(tokenRegisterIndex >= 0, "The wrapper should register the current turn token before canonical spans.");
        Assert.True(invokeScopeIndex >= 0, "The wrapper should start InvokeAgentScope from the telemetry context.");
        Assert.True(activityIndex >= 0, "The wrapper should preserve the custom MessageProcessor activity.");
        Assert.True(contextIndex < baggageIndex, "The telemetry context must be built before baggage scope starts.");
        Assert.True(baggageIndex < tokenRegisterIndex, "Baggage must be active before token registration.");
        Assert.True(baggageIndex < invokeScopeIndex, "Baggage must be active before InvokeAgentScope starts.");
        Assert.True(tokenRegisterIndex < invokeScopeIndex, "The exporter token cache must be populated before InvokeAgentScope starts.");
        Assert.True(invokeScopeIndex < activityIndex, "InvokeAgentScope should wrap the custom MessageProcessor activity.");

        Assert.Contains("public sealed class Agent365TelemetryOptions", options);
        Assert.Contains("public const string SectionName = \"Agent365Observability\";", options);
        Assert.Contains("public string? AgentName { get; init; }", options);
        Assert.Contains("public string? AgentDescription { get; init; }", options);
        Assert.Contains("public string? AgentBlueprintId { get; init; }", options);
        Assert.Contains("public string? AgenticUserId { get; init; }", options);
        Assert.Contains("public string? AgenticUserEmail { get; init; }", options);
        Assert.Contains("public string? MessagingEndpoint { get; init; }", options);
        Assert.Contains("public string DefaultChannelName { get; init; } = \"msteams\";", options);
        Assert.Contains("public string OperationSource { get; init; } = \"W365ComputerUseSample\";", options);

        Assert.Contains("public sealed record Agent365TelemetryContext", context);
        Assert.Contains("FromTurnContext(", context);
        Assert.Contains("FromCurrentActivity(", context);
        Assert.Contains("BuildBaggageScope()", context);
        Assert.Contains("ToRequest(", context);
        Assert.Contains("ToAgentDetails()", context);
        Assert.Contains("ToCallerDetails()", context);
        Assert.Contains(".TenantId(TenantId)", context);
        Assert.Contains(".AgentId(AgentId)", context);
        Assert.Contains(".AgentName(AgentName)", context);
        Assert.Contains(".AgentDescription(AgentDescription)", context);
        Assert.Contains(".AgentBlueprintId(AgentBlueprintId)", context);
        Assert.Contains(".AgenticUserId(AgenticUserId)", context);
        Assert.Contains(".AgenticUserEmail(AgenticUserEmail)", context);
        Assert.Contains(".UserId(UserId)", context);
        Assert.Contains(".UserEmail(UserEmail)", context);
        Assert.Contains(".UserName(UserName)", context);
        Assert.Contains(".UserClientIp(ClientIpAddress)", context);
        Assert.Contains(".InvokeAgentServer(ServerAddress, ServerPort)", context);
        Assert.Contains(".ConversationId(ConversationId)", context);
        Assert.Contains(".ChannelName(ChannelName)", context);
        Assert.Contains(".SessionId(SessionId)", context);
        Assert.Contains(".OperationSource(OperationSource)", context);
    }

    [Fact]
    public void Agent365TelemetryContextUsesAdminCenterSafeFallbacks()
    {
        var context = ReadRepoFile("sample-agent", "Telemetry", "Agent365TelemetryContext.cs");

        Assert.Contains("NormalizeChannelName(", context);
        Assert.Contains("\"msteams\"", context);
        Assert.Contains("IPAddress.Parse(\"0.0.0.0\")", context);
        Assert.Contains("agentBlueprintId = FirstNonEmpty(options?.AgentBlueprintId, options?.ClientId, agentId)", context);
        Assert.Contains("sessionId = conversationId", context);
        Assert.Contains("TryCreateEndpoint(turnContext.Activity.ServiceUrl, options?.MessagingEndpoint)", context);
        Assert.Contains("GetPort(endpoint)", context);
        Assert.Contains("from?.AadObjectId", context);
        Assert.Contains("from?.Id", context);
    }

    [Fact]
    public void A365OtelWrapperLeavesUnresolvedIdentityForTelemetryContextFallback()
    {
        var wrapper = ReadRepoFile("sample-agent", "Telemetry", "A365OtelWrapper.cs");

        var resolveTenantAndAgentId = ExtractMethodBody(
            wrapper,
            "private static async Task<(string agentId, string tenantId)> ResolveTenantAndAgentId");

        Assert.DoesNotContain("agentId = Guid.Empty.ToString();", resolveTenantAndAgentId);
        Assert.DoesNotContain("tenantId = tempTenantId ?? Guid.Empty.ToString();", resolveTenantAndAgentId);
        Assert.Contains("return (agentId, tenantId)", resolveTenantAndAgentId);
    }

    [Fact]
    public void A365OtelWrapperMakesIdentityResolutionBestEffort()
    {
        var wrapper = ReadRepoFile("sample-agent", "Telemetry", "A365OtelWrapper.cs");

        var invokeObservedAgentOperation = ExtractMethodBody(
            wrapper,
            "public static async Task InvokeObservedAgentOperation");
        var resolveTenantAndAgentId = ExtractMethodBody(
            wrapper,
            "private static async Task<(string agentId, string tenantId)> ResolveTenantAndAgentId");

        Assert.True(
            HelperCallContainsSnippets(
                invokeObservedAgentOperation,
                "ResolveTenantAndAgentId",
                "logger")
            || Regex.IsMatch(resolveTenantAndAgentId, @"ResolveTenantAndAgentId\s*\([^)]*ILogger\?\s+logger", RegexOptions.Singleline),
            "Identity resolution should receive or otherwise have access to the wrapper logger.");

        var tryIndex = resolveTenantAndAgentId.IndexOf("try", StringComparison.Ordinal);
        var getTurnTokenIndex = resolveTenantAndAgentId.IndexOf("authSystem.GetTurnTokenAsync", StringComparison.Ordinal);
        var resolveAgentIdentityIndex = resolveTenantAndAgentId.IndexOf("Utility.ResolveAgentIdentity", StringComparison.Ordinal);
        var catchIndex = resolveTenantAndAgentId.IndexOf("catch (Exception ex) when (ex is not OperationCanceledException)", StringComparison.Ordinal);

        Assert.True(tryIndex >= 0, "Identity token resolution should be best-effort.");
        Assert.True(getTurnTokenIndex > tryIndex && getTurnTokenIndex < catchIndex, "GetTurnTokenAsync should be inside the best-effort try block.");
        Assert.True(resolveAgentIdentityIndex > tryIndex && resolveAgentIdentityIndex < catchIndex, "ResolveAgentIdentity should be inside the best-effort try block.");
        Assert.True(catchIndex > tryIndex, "Non-cancellation identity resolution failures should be caught after the resolution attempt.");
        Assert.Contains("logger?.LogWarning", resolveTenantAndAgentId);
        Assert.Contains("Observability identity resolution failed", resolveTenantAndAgentId);
        Assert.DoesNotContain("catch (OperationCanceledException", resolveTenantAndAgentId);
        Assert.Contains("string agentId = \"\";", resolveTenantAndAgentId);
        Assert.Contains("return (agentId, tenantId)", resolveTenantAndAgentId);
        Assert.DoesNotContain("Guid.Empty", resolveTenantAndAgentId);
    }

    [Fact]
    public void A365OtelWrapperRegistersTokenCachesWithFinalTelemetryContextIdentity()
    {
        var wrapper = ReadRepoFile("sample-agent", "Telemetry", "A365OtelWrapper.cs");

        Assert.Matches(
            new Regex(@"var\s+exportAgentId\s*=\s*telemetryContext\.AgentId", RegexOptions.Multiline),
            wrapper);
        Assert.Matches(
            new Regex(@"var\s+exportTenantId\s*=\s*telemetryContext\.TenantId", RegexOptions.Multiline),
            wrapper);
        Assert.Matches(
            new Regex(@"serviceTokenCache\?\.RegisterObservability\(\s*exportAgentId,\s*exportTenantId,", RegexOptions.Singleline),
            wrapper);
        Assert.Matches(
            new Regex(@"agenticTokenCache\.InvalidateToken\(\s*exportAgentId,\s*exportTenantId\s*\)", RegexOptions.Singleline),
            wrapper);
        Assert.Matches(
            new Regex(@"agentTokenCache\?\.RegisterObservability\(\s*exportAgentId,\s*exportTenantId,", RegexOptions.Singleline),
            wrapper);
        Assert.DoesNotContain("serviceTokenCache?.RegisterObservability(\r\n                    agentId,", wrapper);
        Assert.DoesNotContain("agenticTokenCache.InvalidateToken(agentId, tenantId)", wrapper);
        Assert.DoesNotContain("agentTokenCache?.RegisterObservability(\r\n                agentId,", wrapper);
    }

    [Fact]
    public void NonMessageHandlersUseA365OtelWrapperWithAdminCenterContext()
    {
        var agent = ReadRepoFile("sample-agent", "Agent", "MyAgent.cs");

        var welcomeMessageAsync = ExtractMethodBody(agent, "protected async Task WelcomeMessageAsync");
        var onInstallationUpdateAsync = ExtractMethodBody(agent, "protected async Task OnInstallationUpdateAsync");

        Assert.Contains("A365OtelWrapper.InvokeObservedAgentOperation(", welcomeMessageAsync);
        Assert.DoesNotContain("AgentMetrics.InvokeObservedAgentOperation(", welcomeMessageAsync);
        Assert.True(
            HelperCallContainsSnippets(
                welcomeMessageAsync,
                "InvokeObservedAgentOperation",
                "_agentTokenCache",
                "_observabilityTokenCache",
                "_agent365TelemetryOptions",
                "UserAuthorization",
                "GetObservabilityAuthHandlerName(turnContext)",
                "_logger"),
            "WelcomeMessageAsync should route through the full Admin Center observability wrapper and token caches.");

        Assert.Contains("A365OtelWrapper.InvokeObservedAgentOperation(", onInstallationUpdateAsync);
        Assert.DoesNotContain("AgentMetrics.InvokeObservedAgentOperation(", onInstallationUpdateAsync);
        Assert.True(
            HelperCallContainsSnippets(
                onInstallationUpdateAsync,
                "InvokeObservedAgentOperation",
                "_agentTokenCache",
                "_observabilityTokenCache",
                "_agent365TelemetryOptions",
                "UserAuthorization",
                "GetObservabilityAuthHandlerName(turnContext)",
                "_logger"),
            "OnInstallationUpdateAsync should route through the full Admin Center observability wrapper and token caches.");
    }

    [Fact]
    public void AgentOperationStartsInvokeAgentScopeAroundCustomActivity()
    {
        var wrapper = ReadRepoFile("sample-agent", "Telemetry", "A365OtelWrapper.cs");

        var contextIndex = wrapper.IndexOf("Agent365TelemetryContext.FromTurnContext(", StringComparison.Ordinal);
        var baggageIndex = wrapper.IndexOf("using var baggageScope = telemetryContext.BuildBaggageScope();", StringComparison.Ordinal);
        var tokenRegisterIndex = wrapper.IndexOf("serviceTokenCache?.RegisterObservability(", StringComparison.Ordinal);
        var invokeScopeIndex = wrapper.IndexOf("using var invokeAgentScope = StartInvokeAgentScope(turnContext, telemetryContext);", StringComparison.Ordinal);
        var activityIndex = wrapper.IndexOf("AgentMetrics.InvokeObservedAgentOperation", StringComparison.Ordinal);

        var normalizedWrapper = wrapper.Replace("\r\n", "\n");
        Assert.Contains(
            "using var invokeAgentScope = StartInvokeAgentScope(turnContext, telemetryContext);\n        ForceInvokeAgentServerPortTag(invokeAgentScope, telemetryContext);\n        string? outputMessage = null;\n\n        try\n        {\n            await AgentMetrics.InvokeObservedAgentOperation(",
            normalizedWrapper);
        Assert.Contains("using var invokeAgentScope = StartInvokeAgentScope(turnContext, telemetryContext);", wrapper);
        Assert.Contains("private static InvokeAgentScope StartInvokeAgentScope(", wrapper);
        Assert.Contains("Agent365TelemetryContext telemetryContext", wrapper);
        Assert.Contains("return InvokeAgentScope.Start(", wrapper);
        Assert.True(contextIndex >= 0, "The wrapper should build the full Admin Center telemetry context before Agent 365 canonical spans.");
        Assert.True(baggageIndex >= 0, "Baggage must be created from the shared telemetry context before Agent 365 canonical spans.");
        Assert.True(tokenRegisterIndex >= 0, "The current turn token should be cached before exportable canonical spans are created.");
        Assert.True(invokeScopeIndex >= 0, "The wrapper should start InvokeAgentScope for each turn with a using declaration that wraps the custom activity.");
        Assert.True(activityIndex >= 0, "The wrapper should preserve existing custom MessageProcessor activity.");
        Assert.True(contextIndex < baggageIndex, "The telemetry context must be built before baggage scope starts.");
        Assert.True(baggageIndex < tokenRegisterIndex, "Baggage must be active before token registration.");
        Assert.True(baggageIndex < invokeScopeIndex, "Baggage must be active before InvokeAgentScope starts.");
        Assert.True(tokenRegisterIndex < invokeScopeIndex, "The exporter token cache must be populated before InvokeAgentScope starts.");
        Assert.True(invokeScopeIndex < activityIndex, "InvokeAgentScope should wrap the custom MessageProcessor activity.");

        var helperIndex = wrapper.IndexOf("private static InvokeAgentScope StartInvokeAgentScope(", StringComparison.Ordinal);
        var resolveIndex = wrapper.IndexOf("private static async Task<(string agentId, string tenantId)> ResolveTenantAndAgentId", StringComparison.Ordinal);
        Assert.True(helperIndex >= 0, "The wrapper should define StartInvokeAgentScope to build canonical InvokeAgentScope details.");
        Assert.True(resolveIndex > helperIndex, "StartInvokeAgentScope should be a coherent helper before ResolveTenantAndAgentId.");
        var helperBody = wrapper[helperIndex..resolveIndex];
        var normalizedHelperBody = helperBody.Replace("\r\n", "\n");

        Assert.Contains("var agentDetails = telemetryContext.ToAgentDetails();", normalizedHelperBody);
        Assert.Contains("TelemetryContentPolicy.PrepareText(turnContext.Activity.Text ?? string.Empty, \"agent input\")", normalizedHelperBody);
        Assert.Contains("var callerDetails = telemetryContext.ToCallerDetails();", normalizedHelperBody);
        Assert.Contains(
            "return InvokeAgentScope.Start(\n            request: request,\n            scopeDetails: scopeDetails,\n            agentDetails: agentDetails,\n            callerDetails: callerDetails);",
            normalizedHelperBody);
        Assert.Contains("Agent365TelemetryContext telemetryContext", helperBody);
        Assert.Contains("telemetryContext.ToRequest(", helperBody);
        Assert.Contains("telemetryContext.ToAgentDetails()", helperBody);
        Assert.Contains("telemetryContext.ToCallerDetails()", helperBody);
        Assert.DoesNotContain("new Request(", helperBody);
        Assert.DoesNotContain("new BaggageBuilder()", helperBody);
        Assert.DoesNotContain("agentId: agentId", helperBody);
        Assert.DoesNotContain("tenantId: tenantId", helperBody);
        Assert.DoesNotContain("userClientIP", helperBody);
        Assert.Contains("return InvokeAgentScope.Start(", helperBody);
        Assert.Contains("callerDetails: callerDetails", helperBody);
    }

    [Fact]
    public void AgentOperationRecordsInvokeAgentScopeFailureBeforeRethrowing()
    {
        var wrapper = ReadRepoFile("sample-agent", "Telemetry", "A365OtelWrapper.cs");
        var normalizedWrapper = wrapper.Replace("\r\n", "\n");

        Assert.Contains(
            """
            using var invokeAgentScope = StartInvokeAgentScope(turnContext, telemetryContext);
                    ForceInvokeAgentServerPortTag(invokeAgentScope, telemetryContext);
                    string? outputMessage = null;

                    try
                    {
                        await AgentMetrics.InvokeObservedAgentOperation(
                            operationName,
                            turnContext,
                            async () =>
                            {
                                outputMessage = await func().ConfigureAwait(false);
                            }).ConfigureAwait(false);
                        RecordInvokeAgentOutputMessage(invokeAgentScope, outputMessage);
                    }
                    catch (OperationCanceledException)
                    {
                        invokeAgentScope.RecordCancellation();
                        throw;
                    }
                    catch (Exception ex)
                    {
                        invokeAgentScope.RecordError(ex);
                        throw;
                    }
            """.Replace("\r\n", "\n"),
            normalizedWrapper);
    }

    [Fact]
    public void AgentOperationRecordsReturnedOutputMessagesOnInvokeAgentScope()
    {
        var wrapper = ReadRepoFile("sample-agent", "Telemetry", "A365OtelWrapper.cs");
        var agent = ReadRepoFile("sample-agent", "Agent", "MyAgent.cs");

        Assert.Contains("Func<Task<string?>> func", wrapper);
        Assert.Contains("string? outputMessage = null;", wrapper);
        Assert.Contains("outputMessage = await func().ConfigureAwait(false);", wrapper);
        Assert.Contains("RecordInvokeAgentOutputMessage(invokeAgentScope, outputMessage);", wrapper);
        Assert.Contains("invokeAgentScope.RecordOutputMessages(outputMessages);", wrapper);
        Assert.Contains("GetInvokeAgentOutputMessages(outputMessage)", wrapper);

        Assert.Contains("return reply;", agent);
        Assert.Contains("return directResponse;", agent);
        Assert.Contains("return errorMessage;", agent);
        Assert.Contains("return response;", agent);
    }

    [Fact]
    public void AgentOperationOutputMessages_include_nonblank_returned_message()
    {
        var messages = A365OtelWrapper.GetInvokeAgentOutputMessagesForTest("hello world");

        var message = Assert.Single(messages);
        Assert.Equal("<redacted agent output; length=11>", message);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void AgentOperationOutputMessages_skip_blank_returned_messages(string? outputMessage)
    {
        Assert.Empty(A365OtelWrapper.GetInvokeAgentOutputMessagesForTest(outputMessage));
    }

    [Fact]
    public void AgentOperationForcesStringEncodedServerPortOnInvokeAgentScope()
    {
        var wrapper = ReadRepoFile("sample-agent", "Telemetry", "A365OtelWrapper.cs");
        var context = ReadRepoFile("sample-agent", "Telemetry", "Agent365TelemetryContext.cs");

        Assert.Contains("ForceInvokeAgentServerPortTag(invokeAgentScope, telemetryContext);", wrapper);
        Assert.Contains("invokeAgentScope.SetTagMaybe(\"server.port\", telemetryContext.ToServerPortAttribute());", wrapper);
        Assert.Contains("public string ToServerPortAttribute()", context);
        Assert.Contains("CultureInfo.InvariantCulture", context);
        Assert.Contains("builder.Set(\"server.port\", ToServerPortAttribute());", context);
    }

    [Fact]
    public void AgentOperationRegistersCurrentTurnTokenForExporter()
    {
        var wrapper = ReadRepoFile("sample-agent", "Telemetry", "A365OtelWrapper.cs");
        var agent = ReadRepoFile("sample-agent", "Agent", "MyAgent.cs");

        Assert.Contains("ServiceTokenCache observabilityTokenCache", agent);
        Assert.Contains("_observabilityTokenCache", agent);
        Assert.Contains("ServiceTokenCache? serviceTokenCache", wrapper);
        Assert.Contains("var observabilityScopes = EnvironmentUtils.GetObservabilityAuthenticationScope();", wrapper);
        Assert.Contains("authSystem.ExchangeTurnTokenAsync(", wrapper);
        Assert.Contains("serviceTokenCache?.RegisterObservability(", wrapper);
        Assert.Contains("observabilityScopes);", wrapper);
        Assert.DoesNotContain("Observability token preflight:", wrapper);
        Assert.DoesNotContain("Observability token preflight succeeded:", wrapper);
    }

    [Fact]
    public void AgentOperationRefreshesObservabilityTokenCacheForCurrentTurn()
    {
        var wrapper = ReadRepoFile("sample-agent", "Telemetry", "A365OtelWrapper.cs");

        var invalidateIndex = wrapper.IndexOf("agenticTokenCache.InvalidateToken(exportAgentId, exportTenantId)", StringComparison.Ordinal);
        var registerIndex = wrapper.IndexOf("agentTokenCache?.RegisterObservability", StringComparison.Ordinal);

        Assert.True(invalidateIndex >= 0, "The wrapper should invalidate stale token-cache entries before registering the current turn.");
        Assert.True(registerIndex >= 0, "The wrapper should register the current turn for observability token exchange.");
        Assert.True(invalidateIndex < registerIndex, "Stale token-cache entries must be invalidated before registering the current turn.");
    }

    [Fact]
    public void ModelProvidersUseSharedInferenceTelemetry()
    {
        var azureProvider = ReadRepoFile("sample-agent", "ComputerUse", "AzureOpenAIModelProvider.cs");
        var customProvider = ReadRepoFile("sample-agent", "ComputerUse", "CustomEndpointProvider.cs");

        var azureSendAsync = ExtractMethodBody(azureProvider, "public async Task<string> SendAsync");
        var customSendAsync = ExtractMethodBody(customProvider, "public async Task<string> SendAsync");

        Assert.Contains("return await InferenceTelemetry.InvokeAsync(", azureSendAsync);
        Assert.Contains("requestBody", azureSendAsync);
        Assert.Contains("ModelName", azureSendAsync);
        Assert.Contains("providerName: \"azure-openai\"", azureSendAsync);

        var normalizedAzureSendAsync = azureSendAsync.Replace("\r\n", "\n");
        Assert.Contains(
            "return await InferenceTelemetry.InvokeAsync(\n        requestBody,\n        ModelName,\n        providerName: \"azure-openai\",",
            normalizedAzureSendAsync);

        var azureTelemetryDelegate = ExtractTelemetryDelegateBody(azureSendAsync);
        Assert.Contains("_httpClient.SendAsync(req, cancellationToken)", azureTelemetryDelegate);
        Assert.Contains("if (!resp.IsSuccessStatusCode)", azureTelemetryDelegate);
        Assert.Contains("var err = await resp.Content.ReadAsStringAsync(cancellationToken);", azureTelemetryDelegate);
        Assert.Contains("throw new HttpRequestException($\"Azure OpenAI returned {resp.StatusCode}: {err}\");", azureTelemetryDelegate);
        Assert.Contains("resp.Content.ReadAsStringAsync(cancellationToken)", azureTelemetryDelegate);

        Assert.Contains("return await InferenceTelemetry.InvokeAsync(", customSendAsync);
        Assert.Contains("requestBody", customSendAsync);
        Assert.Contains("ModelName", customSendAsync);
        Assert.Contains("providerName: \"custom-endpoint\"", customSendAsync);

        var normalizedCustomSendAsync = customSendAsync.Replace("\r\n", "\n");
        Assert.Contains(
            "return await InferenceTelemetry.InvokeAsync(\n        requestBody,\n        ModelName,\n        providerName: \"custom-endpoint\",",
            normalizedCustomSendAsync);

        var customTelemetryDelegate = ExtractTelemetryDelegateBody(customSendAsync);
        Assert.Contains("_httpClient.SendAsync(req, cancellationToken)", customTelemetryDelegate);
        Assert.Contains("if (!resp.IsSuccessStatusCode)", customTelemetryDelegate);
        Assert.Contains("var err = await resp.Content.ReadAsStringAsync(cancellationToken);", customTelemetryDelegate);
        Assert.Contains("throw new HttpRequestException($\"CustomEndpoint returned {resp.StatusCode}: {err}\");", customTelemetryDelegate);
        Assert.Contains("resp.Content.ReadAsStringAsync(cancellationToken)", customTelemetryDelegate);
    }

    [Fact]
    public void PhysicalToolInvocationCounterCountsPrebuiltAIFunctionArguments()
    {
        var block = @"
await ToolTelemetry.InvokeAsync(...);
var result = await tool.InvokeAsync(aiArgs, ct);
var other = await otherTool.InvokeAsync(new AIFunctionArguments(args), ct);
await RawInvokeToolAsync(tools, name, args, ct);
await InvokeToolAsync(tools, name, args, ct);
await InvokeToolThrowOnErrorAsync(tools, name, args, ct);
";

        Assert.Equal(2, CountDirectAIFunctionInvocations(block));
        Assert.Equal(5, CountPhysicalToolInvocations(block));
    }

    [Fact]
    public void ExtractTelemetryDelegateBodiesAcceptsSyncBlockDelegates()
    {
        var methodBody = @"
return await ToolTelemetry.InvokeAsync(
    toolName: name,
    arguments: args,
    invokeAsync: () =>
    {
        return RawInvokeToolAsync(tools, name, args, ct);
    }).ConfigureAwait(false);
";

        var bodies = ExtractTelemetryDelegateBodies(methodBody);

        var body = Assert.Single(bodies);
        Assert.Contains("RawInvokeToolAsync(tools, name, args, ct)", body);
    }

    [Fact]
    public void ComputerUseOrchestratorUsesSharedToolTelemetry()
    {
        var orchestrator = ReadRepoFile("sample-agent", "ComputerUse", "ComputerUseOrchestrator.cs");
        var helper = ReadRepoFile("sample-agent", "Telemetry", "ToolTelemetry.cs");

        Assert.Contains("public string? ConversationId { get; set; }", orchestrator);
        Assert.Contains("public string? ChannelId { get; set; }", orchestrator);
        Assert.DoesNotContain("ExecuteToolScope.Start(", orchestrator);

        var runTurnAsync = ExtractMethodBody(orchestrator, "private async Task<string> RunTurnAsync");
        var invokeToolAsync = ExtractMethodBody(orchestrator, "internal static async Task<object?> InvokeToolAsync");
        var invokeToolThrowOnErrorAsync = ExtractMethodBody(orchestrator, "internal static async Task<object?> InvokeToolThrowOnErrorAsync");
        var invokeW365ToolAsync = ExtractMethodBody(orchestrator, "private async Task<string> InvokeW365ToolAsync");
        var rawInvokeToolAsync = ExtractMethodBody(orchestrator, "private static async Task<object?> RawInvokeToolAsync");
        var rawInvokeToolThrowOnErrorAsync = ExtractMethodBody(orchestrator, "private static async Task<object?> RawInvokeToolThrowOnErrorAsync");
        var startW365SessionAsync = ExtractMethodBody(orchestrator, "private async Task StartW365SessionAsync");
        var captureScreenshotAsync = ExtractMethodBody(orchestrator, "private async Task<string> CaptureScreenshotAsync");
        var endSessionAsync = ExtractMethodBody(orchestrator, "public static async Task EndSessionAsync");
        var tryGetActiveScreenShareAsync = ExtractMethodBody(orchestrator, "public async Task<(bool Found, string SessionId, string ScreenShareUrl)> TryGetActiveScreenShareAsync");
        var invokeFunctionCallAsync = ExtractMethodBody(orchestrator, "private async Task<JsonElement> InvokeFunctionCallAsync");
        var invokeExposedW365ToolAsync = ExtractMethodBody(orchestrator, "private async Task<string> InvokeExposedW365ToolAsync");
        var invokeW365ToolCheckSessionAsync = ExtractMethodBody(orchestrator, "private async Task<(string Result, bool IsSessionLost)> InvokeW365ToolCheckSessionAsync");
        var recoverAndRetryToolAsync = ExtractMethodBody(orchestrator, "private async Task<string> RecoverAndRetryToolAsync");
        var recoverSessionAsync = ExtractMethodBody(orchestrator, "private async Task RecoverSessionAsync");
        var endSessionOnShutdownAsync = ExtractMethodBody(orchestrator, "public async Task EndSessionOnShutdownAsync");

        var conversationAssignmentIndex = runTurnAsync.IndexOf("session.ConversationId = conversationId;", StringComparison.Ordinal);
        var channelAssignmentIndex = runTurnAsync.IndexOf("session.ChannelId = \"msteams\";", StringComparison.Ordinal);
        var firstToolInvocationIndex = new[]
        {
            runTurnAsync.IndexOf("CaptureScreenshotWithRecoveryAsync", StringComparison.Ordinal),
            runTurnAsync.IndexOf("StartW365SessionAsync", StringComparison.Ordinal),
            runTurnAsync.IndexOf("HandleComputerCallAsync", StringComparison.Ordinal),
            runTurnAsync.IndexOf("InvokeExposedW365ToolAsync", StringComparison.Ordinal),
            runTurnAsync.IndexOf("InvokeFunctionCallAsync", StringComparison.Ordinal),
            runTurnAsync.IndexOf("EndSessionAsync", StringComparison.Ordinal),
        }

        .Where(index => index >= 0)
        .DefaultIfEmpty(-1)
        .Min();
        Assert.True(conversationAssignmentIndex >= 0, "RunTurnAsync should populate session conversation context.");
        Assert.True(channelAssignmentIndex >= 0, "RunTurnAsync should populate session channel context.");
        Assert.True(firstToolInvocationIndex >= 0, "RunTurnAsync should contain tool invocation paths.");
        Assert.True(conversationAssignmentIndex < firstToolInvocationIndex, "Session conversation context must be set before tool invocation.");
        Assert.True(channelAssignmentIndex < firstToolInvocationIndex, "Session channel context must be set before tool invocation.");
        Assert.Contains("EndSessionAsync(", runTurnAsync);
        Assert.Contains("W365GetSessionDetailsToolName", runTurnAsync);
        Assert.True(
            HelperCallContainsSnippets(runTurnAsync, "EndSessionAsync", "toolCallId: callId"),
            "RunTurnAsync EndSession calls should pass the model function call_id into W365 telemetry.");
        Assert.True(
            HelperCallContainsSnippets(runTurnAsync, "InvokeW365ToolCheckSessionAsync", "W365GetSessionDetailsToolName", "toolCallId: callId"),
            "RunTurnAsync GetSessionDetails calls should pass the model function call_id into the session-checked W365 wrapper.");
        Assert.True(
            HelperCallContainsSnippets(runTurnAsync, "RecoverAndRetryToolAsync", "W365GetSessionDetailsToolName", "toolCallId: callId"),
            "RunTurnAsync GetSessionDetails recovery retries should preserve the model function call_id.");

        Assert.Contains("RawInvokeToolAsync(", orchestrator);
        Assert.Contains("RawInvokeToolThrowOnErrorAsync(", orchestrator);
        Assert.DoesNotContain("ToolTelemetry.InvokeAsync(", rawInvokeToolAsync);
        AssertDoesNotCallInstrumentedToolHelpers(rawInvokeToolAsync);
        Assert.Equal(1, CountDirectAIFunctionInvocations(rawInvokeToolAsync));
        Assert.Equal(1, CountPhysicalToolInvocations(rawInvokeToolAsync));
        Assert.DoesNotContain("ToolTelemetry.InvokeAsync(", rawInvokeToolThrowOnErrorAsync);
        AssertDoesNotCallInstrumentedToolHelpers(rawInvokeToolThrowOnErrorAsync);
        Assert.Contains("RawInvokeToolAsync(tools, name, args, ct)", rawInvokeToolThrowOnErrorAsync);
        Assert.Contains("TryExtractToolError", rawInvokeToolThrowOnErrorAsync);
        Assert.Equal(1, CountPhysicalToolInvocations(rawInvokeToolThrowOnErrorAsync));
        Assert.Contains("RawInvokeToolAsync(tools, name, args, ct)", invokeToolThrowOnErrorAsync);
        AssertDoesNotCallInstrumentedToolHelpers(invokeToolThrowOnErrorAsync);
        Assert.DoesNotContain("ToolTelemetry.InvokeAsync(", invokeToolThrowOnErrorAsync);
        Assert.Contains("TryExtractToolError", invokeToolThrowOnErrorAsync);
        Assert.Equal(1, CountPhysicalToolInvocations(invokeToolThrowOnErrorAsync));

        var orchestratorWithoutAllowedPhysicalCalls = orchestrator
            .Replace(rawInvokeToolAsync, string.Empty, StringComparison.Ordinal)
            .Replace(rawInvokeToolThrowOnErrorAsync, string.Empty, StringComparison.Ordinal)
            .Replace(invokeToolThrowOnErrorAsync, string.Empty, StringComparison.Ordinal);
        foreach (var block in ExtractTelemetryCallBlocks(orchestrator))
        {
            orchestratorWithoutAllowedPhysicalCalls = orchestratorWithoutAllowedPhysicalCalls.Replace(block, string.Empty, StringComparison.Ordinal);
        }

        orchestratorWithoutAllowedPhysicalCalls = RemoveMethodDeclarationSignatures(orchestratorWithoutAllowedPhysicalCalls);

        Assert.DoesNotContain("CallToolAsync(", orchestratorWithoutAllowedPhysicalCalls);
        Assert.DoesNotContain("RawInvokeToolAsync(", orchestratorWithoutAllowedPhysicalCalls);
        Assert.DoesNotContain("RawInvokeToolThrowOnErrorAsync(", orchestratorWithoutAllowedPhysicalCalls);
        Assert.DoesNotContain("InvokeToolAsync(", orchestratorWithoutAllowedPhysicalCalls);
        Assert.DoesNotContain("InvokeToolThrowOnErrorAsync(", orchestratorWithoutAllowedPhysicalCalls);
        Assert.DoesNotContain(".InvokeAsync(new AIFunctionArguments", orchestratorWithoutAllowedPhysicalCalls);
        Assert.Equal(0, CountDirectAIFunctionInvocations(orchestratorWithoutAllowedPhysicalCalls));

        AssertAllPhysicalInvocationsAreInsideTelemetryBlocks(invokeToolAsync);
        AssertEveryTelemetryBlockHasExactlyOnePhysicalInvocation(invokeToolAsync);
        Assert.Contains("ToolTelemetry.InvokeAsync(", invokeToolAsync);
        var invokeToolBlocks = ExtractTelemetryCallBlocks(invokeToolAsync);
        var invokeToolBlock = invokeToolBlocks.FirstOrDefault(block =>
            block.Contains("RawInvokeToolAsync(tools, name, args, ct)", StringComparison.Ordinal));
        Assert.NotNull(invokeToolBlock);
        AssertToolTelemetryBlock(
            invokeToolBlock!,
            "toolName: name",
            "arguments: args",
            "mcp",
            "toolCallId: null",
            "RawInvokeToolAsync(tools, name, args, ct)");
        Assert.Contains("conversationId: null", invokeToolBlock!);
        Assert.Contains("channelId: null", invokeToolBlock!);
        var invokeToolDelegates = ExtractTelemetryDelegateBodies(invokeToolAsync);
        Assert.Single(invokeToolDelegates);
        foreach (var body in invokeToolDelegates)
        {
            AssertDoesNotCallInstrumentedToolHelpers(body);
        }

        AssertAllPhysicalInvocationsAreInsideTelemetryBlocks(invokeW365ToolAsync);
        AssertEveryTelemetryBlockHasExactlyOnePhysicalInvocation(invokeW365ToolAsync);
        Assert.Contains("ToolTelemetry.InvokeAsync(", invokeW365ToolAsync);
        Assert.Contains("ConversationSession session", invokeW365ToolAsync);
        Assert.Contains("string? toolCallId = null", invokeW365ToolAsync);
        var invokeW365Blocks = ExtractTelemetryCallBlocks(invokeW365ToolAsync);
        var invokeW365DirectBlock = invokeW365Blocks.FirstOrDefault(block =>
            block.Contains("mcpClient.CallToolAsync(name, args, cancellationToken: ct)", StringComparison.Ordinal));
        Assert.NotNull(invokeW365DirectBlock);
        AssertToolTelemetryBlock(
            invokeW365DirectBlock!,
            "toolName: name",
            "arguments: args",
            "w365",
            "toolCallId: toolCallId",
            "mcpClient.CallToolAsync(name, args, cancellationToken: ct)");
        Assert.Contains("conversationId: session.ConversationId", invokeW365DirectBlock!);
        Assert.Contains("channelId: session.ChannelId", invokeW365DirectBlock!);

        var invokeW365FallbackBlock = invokeW365Blocks.FirstOrDefault(block =>
            block.Contains("RawInvokeToolAsync(tools, name, args, ct)", StringComparison.Ordinal));
        Assert.NotNull(invokeW365FallbackBlock);
        AssertToolTelemetryBlock(
            invokeW365FallbackBlock!,
            "toolName: name",
            "arguments: args",
            "w365",
            "toolCallId: toolCallId",
            "RawInvokeToolAsync(tools, name, args, ct)");
        Assert.Contains("conversationId: session.ConversationId", invokeW365FallbackBlock!);
        Assert.Contains("channelId: session.ChannelId", invokeW365FallbackBlock!);
        var invokeW365Delegates = ExtractTelemetryDelegateBodies(invokeW365ToolAsync);
        Assert.Equal(2, invokeW365Delegates.Count);
        foreach (var body in invokeW365Delegates)
        {
            AssertDoesNotCallInstrumentedToolHelpers(body);
        }

        AssertAllPhysicalInvocationsAreInsideTelemetryBlocks(startW365SessionAsync);
        AssertEveryTelemetryBlockHasExactlyOnePhysicalInvocation(startW365SessionAsync);
        Assert.Contains("ToolTelemetry.InvokeAsync(", startW365SessionAsync);
        Assert.Contains("string? toolCallId = null", startW365SessionAsync);
        var startBlocks = ExtractTelemetryCallBlocks(startW365SessionAsync);
        var startDirectBlock = startBlocks.FirstOrDefault(block =>
            block.Contains("CallToolAsync(W365StartSessionToolName", StringComparison.Ordinal));
        Assert.NotNull(startDirectBlock);
        AssertToolTelemetryBlock(
            startDirectBlock!,
            "toolName: W365StartSessionToolName",
            "arguments: startArgs",
            "w365",
            "toolCallId: toolCallId",
            "CallToolAsync(W365StartSessionToolName");
        Assert.Contains("conversationId: session.ConversationId", startDirectBlock!);
        Assert.Contains("channelId: session.ChannelId", startDirectBlock!);

        var startFallbackBlock = startBlocks.FirstOrDefault(block =>
            block.Contains("RawInvokeToolThrowOnErrorAsync(lifecycleTools, W365StartSessionToolName", StringComparison.Ordinal));
        Assert.NotNull(startFallbackBlock);
        AssertToolTelemetryBlock(
            startFallbackBlock!,
            "toolName: W365StartSessionToolName",
            "arguments: startArgs",
            "w365",
            "toolCallId: toolCallId",
            "RawInvokeToolThrowOnErrorAsync(lifecycleTools, W365StartSessionToolName");
        Assert.Contains("conversationId: session.ConversationId", startFallbackBlock!);
        Assert.Contains("channelId: session.ChannelId", startFallbackBlock!);
        var startDelegates = ExtractTelemetryDelegateBodies(startW365SessionAsync);
        Assert.Equal(2, startDelegates.Count);
        foreach (var body in startDelegates)
        {
            AssertDoesNotCallInstrumentedToolHelpers(body);
        }

        AssertAllPhysicalInvocationsAreInsideTelemetryBlocks(captureScreenshotAsync);
        AssertEveryTelemetryBlockHasExactlyOnePhysicalInvocation(captureScreenshotAsync);
        Assert.Contains("ToolTelemetry.InvokeAsync(", captureScreenshotAsync);
        var screenshotBlocks = ExtractTelemetryCallBlocks(captureScreenshotAsync);
        var screenshotDirectBlock = screenshotBlocks.FirstOrDefault(block =>
            block.Contains("CallToolAsync(\"take_screenshot\"", StringComparison.Ordinal));
        Assert.NotNull(screenshotDirectBlock);
        AssertToolTelemetryBlock(
            screenshotDirectBlock!,
            "toolName: \"take_screenshot\"",
            "arguments: screenshotArgs",
            "w365",
            "toolCallId: null",
            "CallToolAsync(\"take_screenshot\"");
        Assert.Contains("conversationId: session.ConversationId", screenshotDirectBlock!);
        Assert.Contains("channelId: session.ChannelId", screenshotDirectBlock!);

        var screenshotFallbackBlock = screenshotBlocks.FirstOrDefault(block =>
            block.Contains("RawInvokeToolAsync(tools, \"take_screenshot\"", StringComparison.Ordinal));
        Assert.NotNull(screenshotFallbackBlock);
        AssertToolTelemetryBlock(
            screenshotFallbackBlock!,
            "toolName: \"take_screenshot\"",
            "arguments: screenshotArgs",
            "w365",
            "toolCallId: null",
            "RawInvokeToolAsync(tools, \"take_screenshot\"");
        Assert.Contains("conversationId: session.ConversationId", screenshotFallbackBlock!);
        Assert.Contains("channelId: session.ChannelId", screenshotFallbackBlock!);
        var screenshotDelegates = ExtractTelemetryDelegateBodies(captureScreenshotAsync);
        Assert.Equal(2, screenshotDelegates.Count);
        foreach (var body in screenshotDelegates)
        {
            AssertDoesNotCallInstrumentedToolHelpers(body);
        }

        AssertAllPhysicalInvocationsAreInsideTelemetryBlocks(tryGetActiveScreenShareAsync);
        AssertEveryTelemetryBlockHasExactlyOnePhysicalInvocation(tryGetActiveScreenShareAsync);
        Assert.Contains("ToolTelemetry.InvokeAsync(", tryGetActiveScreenShareAsync);
        Assert.Contains("string? toolCallId = null", tryGetActiveScreenShareAsync);
        var screenShareBlocks = ExtractTelemetryCallBlocks(tryGetActiveScreenShareAsync);
        var screenShareDirectBlock = screenShareBlocks.FirstOrDefault(block =>
            block.Contains("CallToolAsync(W365GetSessionDetailsToolName", StringComparison.Ordinal));
        Assert.NotNull(screenShareDirectBlock);
        AssertToolTelemetryBlock(
            screenShareDirectBlock!,
            "toolName: W365GetSessionDetailsToolName",
            "arguments: args",
            "w365",
            "toolCallId: toolCallId",
            "CallToolAsync(W365GetSessionDetailsToolName");
        Assert.Contains("conversationId: session.ConversationId", screenShareDirectBlock!);
        Assert.Contains("channelId: session.ChannelId", screenShareDirectBlock!);
        var screenShareFallbackBlock = screenShareBlocks.FirstOrDefault(block =>
            block.Contains("RawInvokeToolThrowOnErrorAsync(_cachedTools!, W365GetSessionDetailsToolName", StringComparison.Ordinal));
        Assert.NotNull(screenShareFallbackBlock);
        AssertToolTelemetryBlock(
            screenShareFallbackBlock!,
            "toolName: W365GetSessionDetailsToolName",
            "arguments: args",
            "w365",
            "toolCallId: toolCallId",
            "RawInvokeToolThrowOnErrorAsync(_cachedTools!, W365GetSessionDetailsToolName");
        Assert.Contains("conversationId: session.ConversationId", screenShareFallbackBlock!);
        Assert.Contains("channelId: session.ChannelId", screenShareFallbackBlock!);
        var screenShareDelegates = ExtractTelemetryDelegateBodies(tryGetActiveScreenShareAsync);
        Assert.Equal(2, screenShareDelegates.Count);
        foreach (var body in screenShareDelegates)
        {
            AssertDoesNotCallInstrumentedToolHelpers(body);
        }

        AssertAllPhysicalInvocationsAreInsideTelemetryBlocks(endSessionAsync);
        AssertEveryTelemetryBlockHasExactlyOnePhysicalInvocation(endSessionAsync);
        Assert.Contains("ToolTelemetry.InvokeAsync(", endSessionAsync);
        Assert.Contains("string? conversationId = null", endSessionAsync);
        Assert.Contains("string? channelId = null", endSessionAsync);
        Assert.Contains("string? toolCallId = null", endSessionAsync);
        Assert.True(
            HelperCallContainsSnippets(
                runTurnAsync,
                "EndSessionAsync",
                "conversationId: session.ConversationId",
                "channelId: session.ChannelId"),
            "RunTurnAsync EndSession calls should pass the active session context.");
        Assert.True(
            HelperCallContainsSnippets(
                recoverSessionAsync,
                "EndSessionAsync",
                "conversationId: session.ConversationId",
                "channelId: session.ChannelId"),
            "Recovery EndSession calls should pass the active session context.");
        Assert.True(
            HelperCallContainsSnippets(
                endSessionOnShutdownAsync,
                "EndSessionAsync",
                "conversationId: session.ConversationId",
                "channelId: session.ChannelId"),
            "Shutdown EndSession calls should pass the stored session context.");
        var endSessionBlocks = ExtractTelemetryCallBlocks(endSessionAsync);
        var endSessionBlock = endSessionBlocks.FirstOrDefault(block =>
            block.Contains("RawInvokeToolAsync(tools, W365EndSessionToolName", StringComparison.Ordinal));
        Assert.NotNull(endSessionBlock);
        AssertToolTelemetryBlock(
            endSessionBlock!,
            "toolName: W365EndSessionToolName",
            "arguments: args",
            "w365",
            "toolCallId: toolCallId",
            "RawInvokeToolAsync(tools, W365EndSessionToolName");
        Assert.Contains("conversationId: conversationId", endSessionBlock!);
        Assert.Contains("channelId: channelId", endSessionBlock!);
        var endSessionDelegates = ExtractTelemetryDelegateBodies(endSessionAsync);
        Assert.Single(endSessionDelegates);
        foreach (var body in endSessionDelegates)
        {
            AssertDoesNotCallInstrumentedToolHelpers(body);
        }

        AssertAllPhysicalInvocationsAreInsideTelemetryBlocks(invokeFunctionCallAsync);
        AssertEveryTelemetryBlockHasExactlyOnePhysicalInvocation(invokeFunctionCallAsync);
        Assert.Contains("ToolTelemetry.InvokeAsync(", invokeFunctionCallAsync);
        var invokeFunctionBlocks = ExtractTelemetryCallBlocks(invokeFunctionCallAsync);
        var invokeFunctionBlock = invokeFunctionBlocks.FirstOrDefault(block =>
            block.Contains("RawInvokeToolAsync(tools, name, args, ct)", StringComparison.Ordinal));
        Assert.NotNull(invokeFunctionBlock);
        AssertToolTelemetryBlock(
            invokeFunctionBlock!,
            "toolName: name",
            "arguments: args",
            "mcp",
            "toolCallId: callId",
            "RawInvokeToolAsync(tools, name, args, ct)");
        Assert.Contains("conversationId: session.ConversationId", invokeFunctionBlock!);
        Assert.Contains("channelId: session.ChannelId", invokeFunctionBlock!);
        var invokeFunctionDelegates = ExtractTelemetryDelegateBodies(invokeFunctionCallAsync);
        Assert.Single(invokeFunctionDelegates);
        foreach (var body in invokeFunctionDelegates)
        {
            AssertDoesNotCallInstrumentedToolHelpers(body);
        }

        Assert.Contains("var callId = functionCall.GetProperty(\"call_id\").GetString();", invokeExposedW365ToolAsync);
        Assert.Contains("string? toolCallId", invokeW365ToolCheckSessionAsync);
        Assert.Contains("string? toolCallId", recoverAndRetryToolAsync);
        Assert.True(
            HelperCallContainsArgument(invokeExposedW365ToolAsync, "InvokeW365ToolCheckSessionAsync", "callId"),
            "Exposed W365 tool calls should pass the model function call_id into the session-checked W365 wrapper.");
        Assert.True(
            HelperCallContainsArgument(invokeExposedW365ToolAsync, "RecoverAndRetryToolAsync", "callId"),
            "Exposed W365 recovery retries should preserve the model function call_id.");
        Assert.True(
            HelperCallContainsArgument(invokeW365ToolCheckSessionAsync, "InvokeW365ToolAsync", "toolCallId"),
            "Session-checked W365 calls should pass the toolCallId into the telemetry-wrapped raw invocation.");
        Assert.True(
            HelperCallContainsArgument(recoverAndRetryToolAsync, "InvokeW365ToolAsync", "toolCallId"),
            "Recovered W365 retries should pass the toolCallId into the telemetry-wrapped raw invocation.");

        Assert.Contains("ExecuteToolScope.Start(", helper);
        Assert.Contains("new ToolCallDetails(", helper);
        Assert.Contains("ToolType.Function", helper);
        Assert.Contains("RecordResponse", helper);
        Assert.Contains("RecordCancellation()", helper);
        Assert.Contains("RecordError(ex)", helper);
    }

    [Fact]
    public void ProductionSessionPrestartUsesSharedToolTelemetry()
    {
        var client = ReadRepoFile("sample-agent", "ComputerUse", "W365McpSessionClient.cs");
        var method = ExtractMethodBody(client, "public async Task<W365McpToolListResult> StartSessionAndListToolsAsync");

        Assert.Contains("ToolTelemetry.InvokeAsync(", method);
        Assert.Contains("toolName: ComputerUseOrchestrator.W365StartSessionToolName", method);
        Assert.Contains("mcpClient.CallToolAsync(", method);
        Assert.Contains("conversationId: conversationId", method);
        Assert.Contains("channelId: channelId", method);
    }

    [Fact]
    public void ScreenshotDebugJsonDocumentIsDisposed()
    {
        var orchestrator = ReadRepoFile("sample-agent", "ComputerUse", "ComputerUseOrchestrator.cs");
        var method = ExtractMethodBody(orchestrator, "private async Task<string> CaptureScreenshotAsync");

        Assert.Contains("using var responseDocument = JsonDocument.Parse(rawResultJson);", method);
        Assert.Contains("responseDocument.RootElement", method);
    }

    private static void AssertDoesNotCallInstrumentedToolHelpers(string telemetryDelegateBody)
    {
        var instrumentedCallSearchBody = StripMethodSignatureIfPresent(telemetryDelegateBody)
            .Replace("RawInvokeToolAsync(", "RawToolAsync(", StringComparison.Ordinal)
            .Replace("RawInvokeToolThrowOnErrorAsync(", "RawToolThrowOnErrorAsync(", StringComparison.Ordinal);

        Assert.DoesNotContain("InvokeToolAsync(", instrumentedCallSearchBody);
        Assert.DoesNotContain("InvokeToolThrowOnErrorAsync(", instrumentedCallSearchBody);
    }

    private static string RemoveMethodDeclarationSignatures(string source)
    {
        return RemoveMethodDeclarationSignature(
            RemoveMethodDeclarationSignature(source, "InvokeToolAsync"),
            "InvokeToolThrowOnErrorAsync");
    }

    private static string RemoveMethodDeclarationSignature(string source, string methodName)
    {
        var searchIndex = 0;
        while (true)
        {
            var methodNameIndex = source.IndexOf(methodName + "(", searchIndex, StringComparison.Ordinal);
            if (methodNameIndex < 0)
            {
                return source;
            }

            if (!IsMethodDeclaration(source, methodNameIndex))
            {
                searchIndex = methodNameIndex + methodName.Length;
                continue;
            }

            var openBrace = source.IndexOf('{', methodNameIndex);
            Assert.True(openBrace >= 0, $"Could not find opening brace for {methodName} declaration.");
            source = source.Remove(methodNameIndex, openBrace - methodNameIndex);
            searchIndex = methodNameIndex + 1;
        }
    }

    private static bool IsMethodDeclaration(string source, int methodNameIndex)
    {
        var lineStart = source.LastIndexOf('\n', methodNameIndex);
        lineStart = lineStart < 0 ? 0 : lineStart + 1;
        var declarationPrefix = source[lineStart..methodNameIndex];
        return declarationPrefix.Contains("static", StringComparison.Ordinal)
            && declarationPrefix.Contains("Task<object?>", StringComparison.Ordinal);
    }

    private static void AssertToolTelemetryBlock(
        string block,
        string expectedToolNameSnippet,
        string expectedArgumentsSnippet,
        string expectedServerName,
        string expectedToolCallIdSnippet,
        string expectedPhysicalInvocation)
    {
        Assert.Contains(expectedToolNameSnippet, block);
        Assert.Contains(expectedArgumentsSnippet, block);
        Assert.Contains($"toolServerName: \"{expectedServerName}\"", block);
        Assert.Contains(expectedToolCallIdSnippet, block);
        Assert.Contains(expectedPhysicalInvocation, block);
        Assert.Equal(1, CountOccurrences(block, expectedPhysicalInvocation));
        Assert.Equal(1, CountPhysicalToolInvocations(block));
    }

    private static void AssertAllPhysicalInvocationsAreInsideTelemetryBlocks(string methodBody)
    {
        var telemetryBlocks = ExtractTelemetryCallBlocks(methodBody);
        var totalInTelemetry = telemetryBlocks.Sum(CountPhysicalToolInvocations);
        Assert.Equal(CountPhysicalToolInvocations(methodBody), totalInTelemetry);
    }

    private static void AssertEveryTelemetryBlockHasExactlyOnePhysicalInvocation(string methodBody)
    {
        var blocks = ExtractTelemetryCallBlocks(methodBody);
        Assert.NotEmpty(blocks);
        foreach (var block in blocks)
        {
            Assert.Equal(1, CountPhysicalToolInvocations(block));
        }
    }

    private static int CountPhysicalToolInvocations(string block)
    {
        block = StripMethodSignatureIfPresent(block);

        return CountInvocationOccurrences(block, "CallToolAsync(")
            + CountOccurrences(block, "RawInvokeToolAsync(")
            + CountOccurrences(block, "RawInvokeToolThrowOnErrorAsync(")
            + CountInvocationOccurrences(block, "InvokeToolAsync(")
            + CountInvocationOccurrences(block, "InvokeToolThrowOnErrorAsync(")
            + CountDirectAIFunctionInvocations(block);
    }

    private static int CountDirectAIFunctionInvocations(string block)
    {
        return Regex.Matches(block, @"(?<!ToolTelemetry)\.InvokeAsync\(").Count;
    }

    private static string StripMethodSignatureIfPresent(string source)
    {
        var trimmed = source.TrimStart();
        if (!trimmed.StartsWith("private ", StringComparison.Ordinal)
            && !trimmed.StartsWith("public ", StringComparison.Ordinal)
            && !trimmed.StartsWith("internal ", StringComparison.Ordinal)
            && !trimmed.StartsWith("protected ", StringComparison.Ordinal))
        {
            return source;
        }

        var openBrace = source.IndexOf('{');
        return openBrace >= 0 ? source[(openBrace + 1)..] : source;
    }

    private static int CountInvocationOccurrences(string source, string value)
    {
        var count = 0;
        var searchIndex = 0;
        while (true)
        {
            var index = source.IndexOf(value, searchIndex, StringComparison.Ordinal);
            if (index < 0)
            {
                return count;
            }

            if (index == 0 || !IsIdentifierChar(source[index - 1]))
            {
                count++;
            }

            searchIndex = index + value.Length;
        }
    }

    private static bool IsIdentifierChar(char value)
    {
        return char.IsLetterOrDigit(value) || value == '_';
    }

    private static int CountOccurrences(string source, string value)
    {
        var count = 0;
        var searchIndex = 0;
        while (true)
        {
            var index = source.IndexOf(value, searchIndex, StringComparison.Ordinal);
            if (index < 0)
            {
                return count;
            }

            count++;
            searchIndex = index + value.Length;
        }
    }

    private static bool HelperCallContainsArgument(string source, string methodName, string argumentName)
    {
        return HelperCallContainsSnippets(source, methodName, argumentName);
    }

    private static bool HelperCallContainsSnippets(string source, string methodName, params string[] snippets)
    {
        var searchIndex = 0;
        while (true)
        {
            var callStart = source.IndexOf(methodName + "(", searchIndex, StringComparison.Ordinal);
            if (callStart < 0)
            {
                return false;
            }

            var openParen = source.IndexOf('(', callStart);
            Assert.True(openParen >= 0, $"Could not find opening parenthesis for {methodName} invocation.");

            var depth = 0;
            for (var i = openParen; i < source.Length; i++)
            {
                if (source[i] == '(') depth++;
                if (source[i] == ')') depth--;
                if (depth == 0)
                {
                    var invocation = source[openParen..(i + 1)];
                    if (snippets.All(snippet => invocation.Contains(snippet, StringComparison.Ordinal)))
                    {
                        return true;
                    }

                    searchIndex = i + 1;
                    break;
                }
            }

            if (searchIndex <= callStart)
            {
                throw new InvalidOperationException($"Could not find closing parenthesis for {methodName} invocation.");
            }
        }
    }

    private static string ExtractMethodBody(string source, string methodSignatureStart)
    {
        var start = source.IndexOf(methodSignatureStart, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Could not find method starting with {methodSignatureStart}.");
        var openBrace = source.IndexOf('{', start);
        Assert.True(openBrace >= 0, $"Could not find opening brace for {methodSignatureStart}.");
        var closeBrace = FindMatchingBrace(source, openBrace);
        return source[start..(closeBrace + 1)];
    }

    private static int FindMatchingBrace(string source, int openBrace)
    {
        var depth = 0;
        var inString = false;
        var inChar = false;
        var inLineComment = false;
        var inBlockComment = false;
        var isVerbatim = false;

        for (var i = openBrace; i < source.Length; i++)
        {
            var current = source[i];
            var next = i + 1 < source.Length ? source[i + 1] : '\0';
            var previous = i > 0 ? source[i - 1] : '\0';

            if (inLineComment)
            {
                if (current == '\n') inLineComment = false;
                continue;
            }

            if (inBlockComment)
            {
                if (current == '*' && next == '/')
                {
                    inBlockComment = false;
                    i++;
                }
                continue;
            }

            if (inString)
            {
                if (isVerbatim)
                {
                    if (current == '"' && next == '"')
                    {
                        i++;
                    }
                    else if (current == '"')
                    {
                        inString = false;
                        isVerbatim = false;
                    }
                }
                else if (current == '"' && previous != '\\')
                {
                    inString = false;
                }
                continue;
            }

            if (inChar)
            {
                if (current == '\'' && previous != '\\') inChar = false;
                continue;
            }

            if (current == '/' && next == '/')
            {
                inLineComment = true;
                i++;
                continue;
            }

            if (current == '/' && next == '*')
            {
                inBlockComment = true;
                i++;
                continue;
            }

            if (current == '"' || (current == '$' && next == '"') || (current == '@' && next == '"') || (current == '$' && next == '@' && i + 2 < source.Length && source[i + 2] == '"'))
            {
                isVerbatim = current == '@' || (current == '$' && next == '@');
                inString = true;
                if (current != '"') i += isVerbatim && current == '$' ? 2 : 1;
                continue;
            }

            if (current == '\'')
            {
                inChar = true;
                continue;
            }

            if (current == '{') depth++;
            if (current == '}') depth--;
            if (depth == 0) return i;
        }

        throw new InvalidOperationException("Could not find closing brace.");
    }

    private static IReadOnlyList<string> ExtractTelemetryCallBlocks(string methodBody)
    {
        var blocks = new List<string>();
        var searchIndex = 0;
        while (true)
        {
            var callIndex = methodBody.IndexOf("ToolTelemetry.InvokeAsync(", searchIndex, StringComparison.Ordinal);
            if (callIndex < 0)
            {
                return blocks;
            }

            var openParen = methodBody.IndexOf('(', callIndex);
            Assert.True(openParen >= 0, "Could not find ToolTelemetry call opening parenthesis.");
            var depth = 0;
            for (var i = openParen; i < methodBody.Length; i++)
            {
                if (methodBody[i] == '(') depth++;
                if (methodBody[i] == ')') depth--;
                if (depth == 0)
                {
                    blocks.Add(methodBody[callIndex..(i + 1)]);
                    searchIndex = i + 1;
                    break;
                }
            }

            if (searchIndex <= callIndex)
            {
                throw new InvalidOperationException("Could not find ToolTelemetry call closing parenthesis.");
            }
        }
    }

    private static IReadOnlyList<string> ExtractTelemetryDelegateBodies(string methodBody)
    {
        var bodies = new List<string>();
        var searchIndex = 0;
        while (true)
        {
            var callIndex = methodBody.IndexOf("ToolTelemetry.InvokeAsync(", searchIndex, StringComparison.Ordinal);
            if (callIndex < 0)
            {
                return bodies;
            }

            var asyncDelegateIndex = methodBody.IndexOf("async () =>", callIndex, StringComparison.Ordinal);
            var syncDelegateIndex = methodBody.IndexOf("() =>", callIndex, StringComparison.Ordinal);
            var delegateIndex = asyncDelegateIndex >= 0 && (syncDelegateIndex < 0 || asyncDelegateIndex <= syncDelegateIndex)
                ? asyncDelegateIndex
                : syncDelegateIndex;
            Assert.True(delegateIndex >= 0, "Could not find ToolTelemetry delegate.");
            var openBrace = methodBody.IndexOf('{', delegateIndex);
            Assert.True(openBrace >= 0, "Could not find ToolTelemetry delegate opening brace.");

            var depth = 0;
            var foundClosingBrace = false;
            for (var i = openBrace; i < methodBody.Length; i++)
            {
                if (methodBody[i] == '{') depth++;
                if (methodBody[i] == '}') depth--;
                if (depth == 0)
                {
                    bodies.Add(methodBody[openBrace..(i + 1)]);
                    searchIndex = i + 1;
                    foundClosingBrace = true;
                    break;
                }
            }

            if (!foundClosingBrace)
            {
                throw new InvalidOperationException("Could not find ToolTelemetry delegate closing brace.");
            }
        }
    }

    private static string ExtractTelemetryDelegateBody(string methodBody)
    {
        var delegateStart = methodBody.IndexOf("async () =>", StringComparison.Ordinal);
        Assert.True(delegateStart >= 0, "Could not find InferenceTelemetry delegate.");
        var openBrace = methodBody.IndexOf('{', delegateStart);
        Assert.True(openBrace >= 0, "Could not find InferenceTelemetry delegate opening brace.");
        var depth = 0;
        for (var i = openBrace; i < methodBody.Length; i++)
        {
            if (methodBody[i] == '{') depth++;
            if (methodBody[i] == '}') depth--;
            if (depth == 0) return methodBody[openBrace..(i + 1)];
        }

        throw new InvalidOperationException("Could not find InferenceTelemetry delegate closing brace.");
    }

    private static string ReadRepoFile(params string[] pathParts)
    {
        var allParts = new string[pathParts.Length + 1];
        allParts[0] = FindRepositoryRoot();
        Array.Copy(pathParts, 0, allParts, 1, pathParts.Length);

        return File.ReadAllText(Path.Combine(allParts));
    }

    private static string FindRepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (Directory.Exists(Path.Combine(directory.FullName, "sample-agent"))
                && Directory.Exists(Path.Combine(directory.FullName, "sample-agent.Tests")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException("Could not find the W365-SampleAgent repository root.");
    }
}
