// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Microsoft.Agents.Builder;
using Microsoft.Agents.Core;
using System.Diagnostics;
using System.Diagnostics.Metrics;

namespace W365ComputerUseSample.Telemetry;

public static class AgentMetrics
{
    public static readonly string SourceName = "A365.W365ComputerUse";

    public static readonly ActivitySource ActivitySource = new(SourceName);

    private static readonly Meter Meter = new("A365.W365ComputerUse", "1.0.0");

    public static readonly Counter<long> MessageProcessedCounter = Meter.CreateCounter<long>(
        "agent.messages.processed",
        "messages",
        "Number of messages processed by the agent");

    public static readonly Histogram<double> MessageProcessingDuration = Meter.CreateHistogram<double>(
        "agent.message.processing.duration",
        "ms",
        "Duration of message processing in milliseconds");

    public static readonly Counter<long> CuaActionsExecuted = Meter.CreateCounter<long>(
        "agent.cua.actions.executed",
        "actions",
        "Number of CUA computer actions executed");

    public static Activity InitializeMessageHandlingActivity(string handlerName, ITurnContext context)
    {
        var activity = ActivitySource.StartActivity(handlerName);
        activity?.SetTag("Activity.Type", context.Activity.Type.ToString());
        activity?.SetTag("Agent.IsAgentic", context.IsAgenticRequest());
        activity?.SetTag("Caller.Id", context.Activity.From?.Id);
        activity?.SetTag("Conversation.Id", context.Activity.Conversation?.Id);
        activity?.SetTag("Channel.Id", context.Activity.ChannelId?.ToString());

        return activity!;
    }

    public static void FinalizeMessageHandlingActivity(Activity activity, ITurnContext context, long duration, bool success)
    {
        MessageProcessingDuration.Record(duration,
            new("Conversation.Id", context.Activity.Conversation?.Id ?? "unknown"),
            new("Channel.Id", context.Activity.ChannelId?.ToString() ?? "unknown"));

        if (success)
        {
            activity?.SetStatus(ActivityStatusCode.Ok);
        }
        else
        {
            activity?.SetStatus(ActivityStatusCode.Error);
        }

        activity?.Stop();
        activity?.Dispose();
    }

    public static Task InvokeObservedHttpOperation(string operationName, Action func)
    {
        using var activity = ActivitySource.StartActivity(operationName);
        try
        {
            func();
            activity?.SetStatus(ActivityStatusCode.Ok);
        }
        catch (Exception ex)
        {
            activity?.SetStatus(ActivityStatusCode.Error, ex.Message);
            activity?.AddEvent(new ActivityEvent("exception", DateTimeOffset.UtcNow, new()
            {
                ["exception.type"] = ex.GetType().FullName,
                ["exception.message"] = ex.Message,
                ["exception.stacktrace"] = ex.StackTrace
            }));
            throw;
        }

        return Task.CompletedTask;
    }

    public static Task InvokeObservedAgentOperation(string operationName, ITurnContext context, Func<Task> func)
    {
        MessageProcessedCounter.Add(1);
        var activity = InitializeMessageHandlingActivity(operationName, context);
        var stopwatch = Stopwatch.StartNew();
        try
        {
            return func();
        }
        catch (Exception ex)
        {
            activity?.SetStatus(ActivityStatusCode.Error, ex.Message);
            activity?.AddEvent(new ActivityEvent("exception", DateTimeOffset.UtcNow, new()
            {
                ["exception.type"] = ex.GetType().FullName,
                ["exception.message"] = ex.Message,
                ["exception.stacktrace"] = ex.StackTrace
            }));
            throw;
        }
        finally
        {
            stopwatch.Stop();
            FinalizeMessageHandlingActivity(activity, context, stopwatch.ElapsedMilliseconds, true);
        }
    }
}
