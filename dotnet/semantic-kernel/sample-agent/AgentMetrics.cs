using Microsoft.Agents.Builder;
using Microsoft.Agents.Core;
using System;
using System.Diagnostics;
using System.Diagnostics.Metrics;

namespace SemanticKernelSampleAgent
{
    public static class AgentMetrics
    {
        public static readonly string SourceName = "Agent365SemanticKernelSampleAgent";

        public static readonly ActivitySource ActivitySource = new(SourceName);

        private static readonly Meter Meter = new(SourceName);

        public static readonly Counter<long> MessageProcessedCounter = Meter.CreateCounter<long>(
            "agent.messages.processed",
            "messages",
            "Number of messages processed by the agent");

        public static readonly Counter<long> RouteExecutedCounter = Meter.CreateCounter<long>(
            "agent.routes.executed",
            "routes",
            "Number of routes executed by the agent");

        public static readonly Histogram<double> MessageProcessingDuration = Meter.CreateHistogram<double>(
            "agent.message.processing.duration",
            "ms",
            "Duration of message processing in milliseconds");

        public static readonly Histogram<double> RouteExecutionDuration = Meter.CreateHistogram<double>(
            "agent.route.execution.duration",
            "ms",
            "Duration of route execution in milliseconds");

        public static readonly UpDownCounter<long> ActiveConversations = Meter.CreateUpDownCounter<long>(
            "agent.conversations.active",
            "conversations",
            "Number of active conversations");


        public static Activity InitializeMessageHandlingActivity(string HandlerName, ITurnContext context)
        {
            var activity = ActivitySource.StartActivity("AgentNotificationActivityAsync");
            activity?.SetTag("conversation.id", context.Activity.Conversation?.Id);
            activity?.SetTag("channel.id", context.Activity.ChannelId?.ToString());
            activity?.SetTag("message.text.length", context.Activity.Text?.Length ?? 0);
            activity?.SetTag("agent.isagentic", context.IsAgenticRequest());
            activity?.SetTag("caller.id", context.Activity.From?.Id);

            activity?.AddEvent(new ActivityEvent("message.received", DateTimeOffset.UtcNow, new()
            {
                ["message.id"] = context.Activity.Id,
                ["message.text"] = context.Activity.Text,
                ["caller.id"] = context.Activity.From?.Id,
                ["agent.isagentic"] = context.IsAgenticRequest(),
                ["channel.id"] = context.Activity.ChannelId?.ToString()
            }));
            return activity!;
        }

        public static void FinalizeMessageHandlingActivity(Activity activity, ITurnContext context, long duration,  bool success)
        {
            AssertionHelpers.ThrowIfNull(activity, nameof(activity));

            MessageProcessingDuration.Record(duration,
                    new("conversation.id", context.Activity.Conversation?.Id ?? "unknown"),
                    new("channel.id", context.Activity.ChannelId?.ToString() ?? "unknown"));

            RouteExecutedCounter.Add(1,
                new("route.type", "message_handler"),
                new("conversation.id", context.Activity.Conversation?.Id ?? "unknown"));

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


    }
}
