// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Text.Json;

namespace W365ComputerUseSample.ComputerUse;

internal sealed class W365SessionState
{
    public W365SessionState(string? sessionId = null) => SessionId = sessionId;

    public string? SessionId { get; private set; }
    public bool AwaitingHumanLogin { get; private set; }
    public string? ConnectivityUrl { get; private set; }
    public string? ScreenShareUrl { get; private set; }
    private bool readinessReported;

    public void MarkPending() => AwaitingHumanLogin = true;

    public void Apply(string response, bool starting = false)
    {
        using var document = JsonDocument.Parse(response);
        var root = document.RootElement;
        if (Property(root, "isError") is { ValueKind: JsonValueKind.True })
        {
            var message = ErrorText(root);
            if (IsPendingLoginMessage(message) && !string.IsNullOrEmpty(SessionId))
            {
                AwaitingHumanLogin = true;
                readinessReported = true;
                return;
            }

            if (IsEndedMessage(message)) throw new W365SessionEndedException(message);
            throw new InvalidOperationException($"W365 session operation failed: {message}");
        }

        var payload = Payload(root);
        var id = StringProperty(payload, "sessionId");
        if (starting)
        {
            SessionId = !string.IsNullOrWhiteSpace(id) ? id
                : throw new InvalidOperationException("W365 StartSession did not return a sessionId.");
        }
        else if (id != null && !string.Equals(id, SessionId, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("W365 GetSessionDetails returned a different sessionId.");
        }

        readinessReported = Property(payload, "awaitingHumanLogin") != null;
        if (Property(payload, "awaitingHumanLogin") is { } pending)
        {
            if (pending.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            {
                AwaitingHumanLogin = true;
                throw new InvalidOperationException("W365 awaitingHumanLogin must be a boolean.");
            }
            AwaitingHumanLogin = pending.ValueKind == JsonValueKind.True;
        }

        ConnectivityUrl = StringProperty(payload, "connectivityUrl") ?? ConnectivityUrl;
        ScreenShareUrl = StringProperty(payload, "screenShareUrl") ?? ScreenShareUrl;
        if (AwaitingHumanLogin && (!Uri.TryCreate(ConnectivityUrl, UriKind.Absolute, out var url)
            || url.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(url.UserInfo)))
        {
            throw new InvalidOperationException("W365 is awaiting human sign-in but did not return a valid HTTPS connectivityUrl. The session is retained; retry or end it.");
        }
    }

    public async Task<bool> CheckReadinessAsync(
        Func<string, CancellationToken, Task<string>> getDetails,
        CancellationToken cancellationToken,
        Func<TimeSpan, CancellationToken, Task>? delay = null,
        Func<string, CancellationToken, Task<bool>>? confirmReady = null)
    {
        delay ??= Task.Delay;
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        budget.CancelAfter(TimeSpan.FromSeconds(15));
        try
        {
            for (var attempt = 0; AwaitingHumanLogin && attempt < 3; attempt++)
            {
                budget.Token.ThrowIfCancellationRequested();
                if (attempt > 0) await delay(TimeSpan.FromSeconds(2), budget.Token);
                Apply(await getDetails(SessionId ?? throw new InvalidOperationException("No W365 session to inspect."), budget.Token)
                    .WaitAsync(budget.Token));
                if (AwaitingHumanLogin && !readinessReported && confirmReady != null
                    && await confirmReady(SessionId!, budget.Token).WaitAsync(budget.Token))
                {
                    AwaitingHumanLogin = false;
                }
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested && budget.IsCancellationRequested)
        {
            return false;
        }

        return !AwaitingHumanLogin;
    }

    public static bool IsPendingLoginMessage(string message) =>
        message.Contains("awaiting human login", StringComparison.OrdinalIgnoreCase)
        || message.Contains("awaitingHumanLogin", StringComparison.OrdinalIgnoreCase)
        || message.Contains("awaiting human sign-in", StringComparison.OrdinalIgnoreCase)
        || message.Contains("pending human sign-in", StringComparison.OrdinalIgnoreCase)
        || message.Contains("pending human login", StringComparison.OrdinalIgnoreCase)
        || message.Contains("human sign-in is pending", StringComparison.OrdinalIgnoreCase)
        || message.Contains("human login is pending", StringComparison.OrdinalIgnoreCase)
        || message.Contains("waiting for the human to sign in", StringComparison.OrdinalIgnoreCase);

    public static bool IsEndedMessage(string message) =>
        message.Contains("session has ended", StringComparison.OrdinalIgnoreCase)
        || message.Contains("session has been terminated", StringComparison.OrdinalIgnoreCase)
        || message.Contains("session expired", StringComparison.OrdinalIgnoreCase)
        || message.Contains("session not found", StringComparison.OrdinalIgnoreCase)
        || message.Contains("no active session found", StringComparison.OrdinalIgnoreCase)
        || message.Contains("no W365 session found", StringComparison.OrdinalIgnoreCase)
        || message.Contains("session was not found or has expired", StringComparison.OrdinalIgnoreCase)
        || message.Contains("session is not Ready and was removed", StringComparison.OrdinalIgnoreCase);

    private static JsonElement Payload(JsonElement root)
    {
        if (Property(root, "structuredContent") is { ValueKind: JsonValueKind.Object } structured) return structured;
        if (Property(root, "content") is { ValueKind: JsonValueKind.Array } content)
        {
            foreach (var block in content.EnumerateArray())
            {
                if (StringProperty(block, "text") is not { } text) continue;
                try
                {
                    using var nested = JsonDocument.Parse(text);
                    var value = nested.RootElement;
                    if (value.ValueKind == JsonValueKind.Object
                        && (Property(value, "sessionId") != null || Property(value, "awaitingHumanLogin") != null))
                    {
                        return value.Clone();
                    }
                }
                catch (JsonException)
                {
                    // Lifecycle responses may also include plain-text instructions.
                }
            }
        }

        return root;
    }

    private static string ErrorText(JsonElement root) =>
        Property(root, "content") is { ValueKind: JsonValueKind.Array } content
            ? string.Join(Environment.NewLine, content.EnumerateArray().Select(b => StringProperty(b, "text")).OfType<string>())
            : "No error details were returned.";

    private static string? StringProperty(JsonElement element, string name) =>
        Property(element, name) is { ValueKind: JsonValueKind.String } value ? value.GetString() : null;

    private static JsonElement? Property(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object) return null;
        foreach (var property in element.EnumerateObject())
        {
            if (string.Equals(property.Name, name, StringComparison.OrdinalIgnoreCase)) return property.Value;
        }

        return null;
    }
}

internal sealed class W365SessionEndedException(string message) : InvalidOperationException(message);

internal sealed class W365HumanLoginRequiredException : InvalidOperationException
{
    public W365HumanLoginRequiredException() : base("W365 is awaiting human login. Keep the current session and sign in before retrying.") { }
}
