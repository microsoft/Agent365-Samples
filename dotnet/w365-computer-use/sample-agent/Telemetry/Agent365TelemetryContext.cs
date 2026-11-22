// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Diagnostics;
using System.Globalization;
using System.Net;
using Microsoft.Agents.A365.Observability.Runtime.Common;
using Microsoft.Agents.A365.Observability.Runtime.Tracing.Contracts;
using Microsoft.Agents.Builder;
using OpenTelemetry;

namespace W365ComputerUseSample.Telemetry;

public sealed record Agent365TelemetryContext
{
    private static readonly string EmptyId = Guid.Empty.ToString();
    private const string DefaultChannelName = "msteams";
    private const string DefaultOperationSource = "W365ComputerUseSample";

    public string AgentId { get; init; } = EmptyId;

    public string AgentName { get; init; } = string.Empty;

    public string AgentDescription { get; init; } = string.Empty;

    public string TenantId { get; init; } = EmptyId;

    public string AgentBlueprintId { get; init; } = EmptyId;

    public string AgenticUserId { get; init; } = EmptyId;

    public string AgenticUserEmail { get; init; } = string.Empty;

    public string UserId { get; init; } = "unknown-user";

    public string UserEmail { get; init; } = string.Empty;

    public string UserName { get; init; } = string.Empty;

    public IPAddress ClientIpAddress { get; init; } = IPAddress.Any;

    public string ServerAddress { get; init; } = "localhost";

    public int? ServerPort { get; init; } = 443;

    public string ConversationId { get; init; } = EmptyId;

    public string ChannelName { get; init; } = DefaultChannelName;

    public string ChannelLink { get; init; } = string.Empty;

    public string SessionId { get; init; } = EmptyId;

    public string OperationSource { get; init; } = DefaultOperationSource;

    public Uri Endpoint { get; init; } = new("https://localhost/");

    public static Agent365TelemetryContext FromTurnContext(
        ITurnContext turnContext,
        string agentId,
        string tenantId,
        Agent365TelemetryOptions? options)
    {
        ArgumentNullException.ThrowIfNull(turnContext);

        var activity = turnContext.Activity;
        var runtimeEndpoint = GetEndpoint(activity?.ServiceUrl);
        return Create(
            runtimeAgentId: agentId,
            runtimeTenantId: tenantId,
            runtimeUserId: activity?.From?.AadObjectId ?? activity?.From?.Id,
            runtimeUserName: activity?.From?.Name,
            runtimeConversationId: activity?.Conversation?.Id,
            runtimeChannelName: activity?.ChannelId,
            runtimeEndpoint: runtimeEndpoint,
            options: options);
    }

    public static Agent365TelemetryContext FromCurrentActivity(
        string? conversationIdOverride = null,
        string? channelNameOverride = null)
    {
        var activity = Activity.Current;
        var runtimeEndpoint = GetEndpoint(GetActivityValue(activity, BaggageKeys.Endpoint));
        return Create(
            runtimeAgentId: GetActivityValue(activity, BaggageKeys.AgentId),
            runtimeTenantId: GetActivityValue(activity, BaggageKeys.TenantId),
            runtimeUserId: GetActivityValue(activity, BaggageKeys.UserId),
            runtimeUserName: GetActivityValue(activity, BaggageKeys.UserName),
            runtimeConversationId: conversationIdOverride ?? GetActivityValue(activity, BaggageKeys.ConversationId),
            runtimeChannelName: channelNameOverride ?? GetActivityValue(activity, BaggageKeys.ChannelName),
            runtimeEndpoint: runtimeEndpoint,
            options: null);
    }

    public IDisposable BuildBaggageScope()
    {
        var builder = new BaggageBuilder()
            .TenantId(TenantId)
            .AgentId(AgentId)
            .AgentName(AgentName)
            .AgentDescription(AgentDescription)
            .AgenticUserId(AgenticUserId)
            .AgenticUserEmail(AgenticUserEmail)
            .AgentBlueprintId(AgentBlueprintId)
            .UserId(UserId)
            .UserEmail(UserEmail)
            .UserName(UserName)
            .UserClientIp(ClientIpAddress)
            .InvokeAgentServer(ServerAddress, ServerPort)
            .ConversationId(ConversationId)
            .ChannelName(ChannelName)
            .ChannelLink(ChannelLink)
            .SessionId(SessionId)
            .OperationSource(OperationSource);

        builder.Set("server.port", ToServerPortAttribute());
        return builder.Build();
    }

    public string ToServerPortAttribute()
    {
        var port = ServerPort is >= 1 and <= 65535 ? ServerPort.Value : 443;
        return port.ToString(CultureInfo.InvariantCulture);
    }

    public AgentDetails ToAgentDetails() =>
        new(
            agentId: AgentId,
            agentName: AgentName,
            agentDescription: AgentDescription,
            agenticUserId: AgenticUserId,
            agenticUserEmail: AgenticUserEmail,
            agentBlueprintId: AgentBlueprintId,
            tenantId: TenantId,
            agentClientIP: ClientIpAddress);

    public Request ToRequest(
        string? content = null,
        string? conversationId = null,
        string? channelName = null) =>
        new(
            content: content ?? string.Empty,
            sessionId: SessionId,
            channel: new Channel(channelName ?? ChannelName, ChannelLink),
            conversationId: conversationId ?? ConversationId,
            operationSource: OperationSource);

    public CallerDetails ToCallerDetails() =>
        new(new UserDetails(
            userId: UserId,
            userEmail: UserEmail,
            userName: UserName,
            userClientIP: ClientIpAddress));

    public InvokeAgentScopeDetails ToInvokeEndpoint() => new(endpoint: Endpoint);

    private static Agent365TelemetryContext Create(
        string? runtimeAgentId,
        string? runtimeTenantId,
        string? runtimeUserId,
        string? runtimeUserName,
        string? runtimeConversationId,
        string? runtimeChannelName,
        Uri? runtimeEndpoint,
        Agent365TelemetryOptions? options)
    {
        var baggageEndpoint = GetEndpoint(GetBaggageValue(BaggageKeys.Endpoint));
        var configuredEndpoint = GetEndpoint(options?.MessagingEndpoint);
        var endpoint = runtimeEndpoint ?? baggageEndpoint ?? configuredEndpoint;

        var serverAddress = FirstValidHost(
            runtimeEndpoint?.Host,
            GetBaggageValue(BaggageKeys.ServerAddress),
            configuredEndpoint?.Host,
            "localhost");
        var serverPort = FirstValidPort(
            runtimeEndpoint?.IsDefaultPort == false ? runtimeEndpoint.Port.ToString(CultureInfo.InvariantCulture) : null,
            GetBaggageValue(BaggageKeys.ServerPort),
            configuredEndpoint?.IsDefaultPort == false ? configuredEndpoint.Port.ToString(CultureInfo.InvariantCulture) : null);

        return new Agent365TelemetryContext
        {
            AgentId = FirstRequired(runtimeAgentId, GetBaggageValue(BaggageKeys.AgentId), options?.AgentId),
            AgentName = FirstValue(GetBaggageValue(BaggageKeys.AgentName), options?.AgentName),
            AgentDescription = FirstValue(GetBaggageValue(BaggageKeys.AgentDescription), options?.AgentDescription),
            TenantId = FirstRequired(runtimeTenantId, GetBaggageValue(BaggageKeys.TenantId), options?.TenantId),
            AgentBlueprintId = FirstRequired(GetBaggageValue(BaggageKeys.AgentBlueprintId), options?.AgentBlueprintId),
            AgenticUserId = FirstRequired(GetBaggageValue(BaggageKeys.AgenticUserId), options?.AgenticUserId),
            AgenticUserEmail = FirstValue(GetBaggageValue(BaggageKeys.AgenticUserEmail), options?.AgenticUserEmail),
            UserId = FirstValue(runtimeUserId, GetBaggageValue(BaggageKeys.UserId), "unknown-user"),
            UserEmail = FirstValue(GetBaggageValue(BaggageKeys.UserEmail)),
            UserName = FirstValue(runtimeUserName, GetBaggageValue(BaggageKeys.UserName)),
            ClientIpAddress = FirstValidIp(GetBaggageValue(BaggageKeys.ClientAddress)),
            ServerAddress = serverAddress,
            ServerPort = serverPort,
            ConversationId = FirstRequired(runtimeConversationId, GetBaggageValue(BaggageKeys.ConversationId)),
            ChannelName = FirstValue(runtimeChannelName, GetBaggageValue(BaggageKeys.ChannelName), options?.DefaultChannelName, DefaultChannelName),
            ChannelLink = FirstValue(GetBaggageValue(BaggageKeys.ChannelLink)),
            SessionId = FirstRequired(GetBaggageValue(BaggageKeys.SessionId), runtimeConversationId, GetBaggageValue(BaggageKeys.ConversationId)),
            OperationSource = FirstValue(GetBaggageValue(BaggageKeys.OperationSource), options?.OperationSource, DefaultOperationSource),
            Endpoint = endpoint ?? CreateFallbackEndpoint(serverAddress, serverPort),
        };
    }

    private static string FirstRequired(params string?[] values) =>
        FirstValue(values.Append(EmptyId).ToArray());

    private static string FirstValue(params string?[] values) =>
        values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value))?.Trim() ?? string.Empty;

    private static string FirstValidHost(params string?[] values) =>
        values.FirstOrDefault(IsValidHost) ?? "localhost";

    private static int FirstValidPort(params string?[] values)
    {
        foreach (var value in values)
        {
            if (int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var port)
                && port is >= 1 and <= 65535)
            {
                return port;
            }
        }

        return 443;
    }

    private static IPAddress FirstValidIp(string? value) =>
        IPAddress.TryParse(value, out var address) ? address : IPAddress.Any;

    private static Uri? GetEndpoint(string? value)
    {
        return Uri.TryCreate(value, UriKind.Absolute, out var endpoint)
            && (endpoint.Scheme == Uri.UriSchemeHttp || endpoint.Scheme == Uri.UriSchemeHttps)
            ? endpoint
            : null;
    }

    private static Uri CreateFallbackEndpoint(string serverAddress, int serverPort) =>
        new UriBuilder(Uri.UriSchemeHttps, serverAddress, serverPort).Uri;

    private static bool IsValidHost(string? value) =>
        !string.IsNullOrWhiteSpace(value)
        && Uri.CheckHostName(value) is UriHostNameType.Dns or UriHostNameType.IPv4 or UriHostNameType.IPv6;

    private static string? GetActivityValue(Activity? activity, string key) =>
        activity?.GetTagItem(key)?.ToString();

    private static string? GetBaggageValue(string key) => Baggage.GetBaggage(key);

    private static class BaggageKeys
    {
        public const string AgentId = "gen_ai.agent.id";
        public const string AgentName = "gen_ai.agent.name";
        public const string AgentDescription = "gen_ai.agent.description";
        public const string AgenticUserId = "microsoft.agent.user.id";
        public const string AgenticUserEmail = "microsoft.agent.user.email";
        public const string AgentBlueprintId = "microsoft.a365.agent.blueprint.id";
        public const string TenantId = "microsoft.tenant.id";
        public const string UserId = "user.id";
        public const string UserEmail = "user.email";
        public const string UserName = "user.name";
        public const string ClientAddress = "client.address";
        public const string ServerAddress = "server.address";
        public const string ServerPort = "server.port";
        public const string ConversationId = "gen_ai.conversation.id";
        public const string ChannelName = "microsoft.channel.name";
        public const string ChannelLink = "microsoft.channel.link";
        public const string SessionId = "microsoft.session.id";
        public const string OperationSource = "service.name";
        public const string Endpoint = "server.url";
    }
}
