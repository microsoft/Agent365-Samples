// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Microsoft.Agents.A365.Observability.Runtime.Common;
using Microsoft.Agents.A365.Observability.Runtime.Tracing.Contracts;
using Microsoft.Agents.A365.Runtime.Utils;
using Microsoft.Agents.Builder;
using OpenTelemetry;
using System.Diagnostics;
using System.Net;

namespace W365ComputerUseSample.Telemetry;

public sealed record Agent365TelemetryContext
{
    public string? AgentId { get; init; }

    public string? AgentName { get; init; }

    public string? AgentDescription { get; init; }

    public string? TenantId { get; init; }

    public string? AgentBlueprintId { get; init; }

    public string? AgenticUserId { get; init; }

    public string? AgenticUserEmail { get; init; }

    public string? UserId { get; init; }

    public string? UserEmail { get; init; }

    public string? UserName { get; init; }

    public IPAddress ClientIpAddress { get; init; } = IPAddress.Parse("0.0.0.0");

    public string? ServerAddress { get; init; }

    public int? ServerPort { get; init; }

    public string? ConversationId { get; init; }

    public string? ChannelName { get; init; }

    public string? ChannelLink { get; init; }

    public string? SessionId { get; init; }

    public string OperationSource { get; init; } = "W365ComputerUseSample";

    public Uri? Endpoint { get; init; }

    public static Agent365TelemetryContext FromTurnContext(
        ITurnContext turnContext,
        string agentId,
        string tenantId,
        Agent365TelemetryOptions? options)
    {
        ArgumentNullException.ThrowIfNull(turnContext);

        var currentActivity = Activity.Current;
        agentId = FirstNonEmpty(
            agentId,
            turnContext.Activity.IsAgenticRequest() ? turnContext.Activity.GetAgenticInstanceId() : null,
            ReadBaggage(currentActivity, "gen_ai.agent.id"),
            options?.AgentId,
            Guid.Empty.ToString())!;
        tenantId = FirstNonEmpty(
            tenantId,
            turnContext.Activity.Conversation?.TenantId,
            turnContext.Activity.Recipient?.TenantId,
            ReadBaggage(currentActivity, "microsoft.tenant.id"),
            options?.TenantId,
            Guid.Empty.ToString())!;
        var agentBlueprintId = FirstNonEmpty(options?.AgentBlueprintId, options?.ClientId, agentId);
        agentBlueprintId = FirstNonEmpty(
            ReadBaggage(currentActivity, "microsoft.a365.agent.blueprint.id"),
            agentBlueprintId);
        var conversationId = FirstNonEmpty(turnContext.Activity.Conversation?.Id, Guid.NewGuid().ToString("D"))!;
        var sessionId = conversationId;
        var runtimeEndpoint = TryCreateEndpoint(turnContext.Activity.ServiceUrl, null);
        var baggageChannelLink = ReadBaggage(currentActivity, "microsoft.channel.link");
        var baggageEndpoint = TryCreateEndpoint(baggageChannelLink, null);
        var configuredEndpoint = TryCreateEndpoint(turnContext.Activity.ServiceUrl, options?.MessagingEndpoint);
        var endpoint = runtimeEndpoint ?? baggageEndpoint ?? configuredEndpoint;
        var serverAddress = FirstNonEmpty(
            runtimeEndpoint?.Host,
            ReadBaggage(currentActivity, "server.address"),
            baggageEndpoint?.Host,
            endpoint?.Host,
            "localhost");
        var serverPort = runtimeEndpoint is not null
            ? GetPort(runtimeEndpoint)
            : TryParsePort(ReadBaggage(currentActivity, "server.port"))
                ?? (baggageEndpoint is not null ? GetPort(baggageEndpoint) : null)
                ?? (endpoint is not null ? GetPort(endpoint) : null)
                ?? 443;
        var from = turnContext.Activity.From;

        return new Agent365TelemetryContext
        {
            AgentId = agentId,
            AgentName = FirstNonEmpty(
                turnContext.Activity.Recipient?.Name,
                ReadBaggage(currentActivity, "gen_ai.agent.name"),
                options?.AgentName),
            AgentDescription = FirstNonEmpty(
                ReadBaggage(currentActivity, "gen_ai.agent.description"),
                options?.AgentDescription),
            TenantId = tenantId,
            AgentBlueprintId = agentBlueprintId,
            AgenticUserId = FirstNonEmpty(
                ReadBaggage(currentActivity, "microsoft.agent.user.id"),
                options?.AgenticUserId),
            AgenticUserEmail = FirstNonEmpty(
                ReadBaggage(currentActivity, "microsoft.agent.user.email"),
                options?.AgenticUserEmail),
            UserId = FirstNonEmpty(
                from?.AadObjectId,
                from?.Id,
                ReadBaggage(currentActivity, "user.id"),
                "unknown-user"),
            UserEmail = ReadBaggage(currentActivity, "user.email"),
            UserName = FirstNonEmpty(
                from?.Name,
                ReadBaggage(currentActivity, "user.name")),
            ClientIpAddress = TryParseIpAddress(ReadBaggage(currentActivity, "client.address")) ?? IPAddress.Parse("0.0.0.0"),
            ServerAddress = serverAddress,
            ServerPort = serverPort,
            ConversationId = conversationId,
            ChannelName = NormalizeChannelName(
                FirstNonEmpty(
                    turnContext.Activity.ChannelId?.ToString(),
                    ReadBaggage(currentActivity, "microsoft.channel.name")),
                options?.DefaultChannelName),
            ChannelLink = FirstNonEmpty(
                endpoint?.ToString(),
                baggageChannelLink),
            SessionId = sessionId,
            OperationSource = FirstNonEmpty(
                ReadBaggage(currentActivity, "operation.source"),
                ReadBaggage(currentActivity, "service.name"),
                options?.OperationSource,
                "W365ComputerUseSample")!,
            Endpoint = endpoint,
        };
    }

    public static Agent365TelemetryContext FromCurrentActivity(
        string? conversationIdOverride = null,
        string? channelNameOverride = null)
    {
        var activity = Activity.Current;
        var agentId = FirstNonEmpty(
            ReadBaggage(activity, "gen_ai.agent.id"),
            Guid.Empty.ToString())!;
        var tenantId = FirstNonEmpty(
            ReadBaggage(activity, "microsoft.tenant.id"),
            Guid.Empty.ToString())!;
        var conversationId = FirstNonEmpty(
            conversationIdOverride,
            ReadBaggage(activity, "gen_ai.conversation.id"),
            Guid.NewGuid().ToString("D"))!;
        var sessionId = FirstNonEmpty(ReadBaggage(activity, "microsoft.session.id"), conversationId);
        var channelLink = ReadBaggage(activity, "microsoft.channel.link");
        var endpoint = TryCreateEndpoint(channelLink, null);
        var serverAddress = FirstNonEmpty(ReadBaggage(activity, "server.address"), endpoint?.Host, "localhost");
        var serverPort = TryParsePort(ReadBaggage(activity, "server.port")) ?? GetPort(endpoint) ?? 443;
        var agentBlueprintId = FirstNonEmpty(ReadBaggage(activity, "microsoft.a365.agent.blueprint.id"), agentId);

        return new Agent365TelemetryContext
        {
            AgentId = agentId,
            AgentName = ReadBaggage(activity, "gen_ai.agent.name"),
            AgentDescription = ReadBaggage(activity, "gen_ai.agent.description"),
            TenantId = tenantId,
            AgentBlueprintId = agentBlueprintId,
            AgenticUserId = ReadBaggage(activity, "microsoft.agent.user.id"),
            AgenticUserEmail = ReadBaggage(activity, "microsoft.agent.user.email"),
            UserId = FirstNonEmpty(ReadBaggage(activity, "user.id"), "unknown-user"),
            UserEmail = ReadBaggage(activity, "user.email"),
            UserName = ReadBaggage(activity, "user.name"),
            ClientIpAddress = TryParseIpAddress(ReadBaggage(activity, "client.address")) ?? IPAddress.Parse("0.0.0.0"),
            ServerAddress = serverAddress,
            ServerPort = serverPort,
            ConversationId = conversationId,
            ChannelName = NormalizeChannelName(
                FirstNonEmpty(channelNameOverride, ReadBaggage(activity, "microsoft.channel.name")),
                null),
            ChannelLink = channelLink,
            SessionId = sessionId,
            OperationSource = FirstNonEmpty(
                ReadBaggage(activity, "operation.source"),
                ReadBaggage(activity, "service.name"),
                "W365ComputerUseSample")!,
            Endpoint = endpoint,
        };
    }

    public IDisposable BuildBaggageScope()
    {
        return new BaggageBuilder()
            .TenantId(TenantId)
            .AgentId(AgentId)
            .AgentName(AgentName)
            .AgentDescription(AgentDescription)
            .AgentBlueprintId(AgentBlueprintId)
            .AgenticUserId(AgenticUserId)
            .AgenticUserEmail(AgenticUserEmail)
            .UserId(UserId)
            .UserEmail(UserEmail)
            .UserName(UserName)
            .UserClientIp(ClientIpAddress)
            .InvokeAgentServer(ServerAddress, ServerPort)
            .ConversationId(ConversationId)
            .ChannelName(ChannelName)
            .ChannelLink(ChannelLink)
            .SessionId(SessionId)
            .OperationSource(OperationSource)
            .Build();
    }

    public AgentDetails ToAgentDetails()
    {
        return new AgentDetails(
            agentId: AgentId,
            agentName: AgentName,
            agentDescription: AgentDescription,
            agenticUserId: AgenticUserId,
            agenticUserEmail: AgenticUserEmail,
            agentBlueprintId: AgentBlueprintId,
            tenantId: TenantId,
            agentClientIP: ClientIpAddress);
    }

    public Request ToRequest(string? content = null, string? conversationId = null, string? channelName = null)
    {
        var resolvedConversationId = FirstNonEmpty(conversationId, ConversationId);
        var resolvedChannelName = channelName is null
            ? ChannelName
            : NormalizeChannelName(channelName, ChannelName);

        return new Request(
            content: content,
            sessionId: SessionId,
            channel: new Channel(resolvedChannelName, ChannelLink),
            conversationId: resolvedConversationId,
            operationSource: OperationSource);
    }

    public CallerDetails ToCallerDetails()
    {
        return new CallerDetails(
            userDetails: new UserDetails(
                userId: UserId,
                userEmail: UserEmail,
                userName: UserName,
                userClientIP: ClientIpAddress));
    }

    public Uri? ToInvokeEndpoint()
    {
        if (Endpoint is not null)
        {
            return Endpoint;
        }

        var serverAddress = FirstNonEmpty(ServerAddress, "localhost")!;
        var serverPort = ServerPort is >= 1 and <= 65535 ? ServerPort.Value : 443;

        return new UriBuilder(Uri.UriSchemeHttps, serverAddress, serverPort).Uri;
    }

    private static string NormalizeChannelName(string? channelName, string? defaultChannelName)
    {
        return FirstNonEmpty(channelName, defaultChannelName, "msteams")!.Trim().ToLowerInvariant();
    }

    private static Uri? TryCreateEndpoint(string? serviceUrl, string? fallbackUrl)
    {
        foreach (var value in new[] { serviceUrl, fallbackUrl })
        {
            if (Uri.TryCreate(value, UriKind.Absolute, out var endpoint)
                && (string.Equals(endpoint.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(endpoint.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)))
            {
                return endpoint;
            }
        }

        return null;
    }

    private static int? GetPort(Uri? endpoint)
    {
        if (endpoint is null)
        {
            return 443;
        }

        if (endpoint.IsDefaultPort)
        {
            if (string.Equals(endpoint.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase))
            {
                return 80;
            }

            if (string.Equals(endpoint.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
            {
                return 443;
            }
        }

        return endpoint.Port;
    }

    private static IPAddress? TryParseIpAddress(string? address)
    {
        return IPAddress.TryParse(address, out var ipAddress)
            ? ipAddress
            : null;
    }

    private static int? TryParsePort(string? port)
    {
        return int.TryParse(port, out var parsedPort) && parsedPort is >= 1 and <= 65535
            ? parsedPort
            : null;
    }

    private static string? ReadBaggage(Activity? activity, string key)
    {
        return FirstNonEmpty(
            Baggage.Current.GetBaggage(key),
            activity?.GetBaggageItem(key));
    }

    private static string? FirstNonEmpty(params string?[] values)
    {
        foreach (var value in values)
        {
            if (!string.IsNullOrWhiteSpace(value))
            {
                return value;
            }
        }

        return null;
    }
}
