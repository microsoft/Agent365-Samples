# Agent Code Walkthrough

This document provides a detailed walkthrough of the code for this agent. The 
agent is designed to perform specific tasks autonomously, interacting with the
user as needed.

## Key Files in this Solution
- `Program.cs`:
  - This is the entry point for the application. It sets up the necessary services 
    and middleware for the agent.
  - Tracing is configured here to help with debugging and monitoring the agent's activities.
    ```csharp
    builder.Services
        .AddTracing(config => config
            .WithSemanticKernel());

    builder.Services
       .AddOpenTelemetry()
       .WithTracing(tracing => tracing
           .AddConsoleExporter());
    ```
- `MyAgent.cs`:
  - This file contains the implementation of the agent's core logic, including how
    it registers handling of activities.
  - The constructor has three lines that register the agent's handling of activities:
    - `this.OnAgentNotification("*", AgentNotificationActivityAsync);`:
      - This registers a handler for notifications, such as when the agent 
        receives an email or a user mentions the agent in a comment in a Word document.
    - `OnActivity(ActivityTypes.InstallationUpdate, OnHireMessageAsync);`:
      - This registers the `InstallationUpdate` activity type, which is triggered
        when the agent is installed ("hired") or uninstalled ("offboarded").
    - `OnActivity(ActivityTypes.Message, MessageActivityAsync, rank: RouteRank.Last);`:
      - This registers a handler for messages sent to the agent.
  - Based on the activity handlers registered above, when the agent receives a message
    about an activity, the relevant handler is invoked to process the activity.
- `Agents/Agent365Agent.cs`:
  - This file contains the implementation of the Agent 365 specific logic, including how it
    integrates with the Agent 365 platform and handles user interactions.
  - We call `IMcpToolRegistrationService.AddToolServersToAgent(...)` to register
    the Agent 365 tools with the agent.
- `Plugins/TermsAndConditionsAcceptedPlugin.cs`:
  - This file contains a Semantic Kernel plugin that handles the scenario where
    the user has accepted the terms and conditions.
  - This contains a simple tool that allows the user to reject the terms and conditions
    if they change their mind.
- `Plugins/TermsAndConditionsNotAcceptedPlugin.cs`:
  - This file contains a Semantic Kernel plugin that handles the scenario where
    the user has not accepted the terms and conditions.
  - This contains a simple tool that allows the user to accept the terms and conditions.

## Activities Handled by the Agent

### InstallationUpdate Activity

- This activity is triggered when the agent is installed or uninstalled.
- The `OnHireMessageAsync` method in `MyAgent.cs` handles this activity:
  - If the agent is installed, it sends a welcome message to the user, asking
    the user to accept the terms and conditions.
  - If the agent is uninstalled, it sends a goodbye message to the user, and it
    resets the user's acceptance of the terms and conditions.
- The `TermsAndConditionsAccepted` flag has been implemented as a static property
  in the `MyAgent` class for simplicity. In a production scenario, this should be
  stored in a persistent storage solution. It is only intended as a simple example
  to demonstrate the `InstallationUpdate` activity.

### Notification Activity

- This activity is triggered when the agent receives a notification, such as
  when the user mentions the agent in a comment in a Word document or when the
  agent receives an email.
- The `AgentNotificationActivityAsync` method in `MyAgent.cs` handles this activity:
  - It processes the notification and takes appropriate action based on the content
    of the notification.

### Message Activity

- This activity is triggered when the agent receives a message from the user.
- The `MessageActivityAsync` method in `MyAgent.cs` handles this activity:
  - It processes the message and takes appropriate action based on the content
    of the message.

### Activity Protocol Samples

For more information on the activity protocol and sample payloads, please refer to the
[Activity Protocol Samples](Activity-Protocol-Samples.md).
