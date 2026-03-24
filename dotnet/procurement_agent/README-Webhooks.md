# Webhook Configuration for Agents

## Overview

The agent system now supports webhook URLs for processing email messages. When a webhook URL is configured for an agent, incoming email messages will be forwarded to the webhook in Activity Protocol format instead of being processed directly by the agent logic.

## Configuration

### Setting a Webhook URL

To configure a webhook URL for a agent, update the `WebhookUrl` property in the `AgentMetadata` table storage entity.

Example:
```json
{
  "WebhookUrl": "https://your-webhook-endpoint.com/api/messages"
}
```

### Activity Protocol Format

When a webhook URL is configured, email messages are converted to Activity Protocol format for email channel before being sent to the webhook endpoint.

Example payload sent to webhook:
```json
{
  "type": "message",
  "id": "AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0AGvcQts7M_EOS9-b-8ASqOQAACvyyhgAA",
  "timestamp": "2025-08-07T20:11:30.6098113Z",
  "serviceUrl": "https://email.botframework.com/",
  "channelId": "email",
  "from": {
    "id": "user@company.com",
    "name": "John Doe"
  },
  "conversation": {
    "isGroup": false,
    "id": "email-user-company-com-agent-company-com"
  },
  "recipient": {
    "id": "agent@company.com",
    "name": "Hello World Agent"
  },
  "text": "What is GDPR law?",
  "attachments": [],
  "entities": [
    {
      "type": "mention",
      "mentioned": {
        "id": "agent@company.com",
        "name": "Hello World Agent"
      },
      "text": "mailto:agent@company.com"
    }
  ],
  "channelData": {
    "Subject": "What is GDPR",
    "Importance": 1,
    "DateTimeSent": "2025-08-07T20:11:20+00:00",
    "Id": {
      "UniqueId": "AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0AGvcQts7M_EOS9-b-8ASqOQAACvyyhgAA",
      "ChangeKey": null
    },
    "ToRecipients": [
      {
        "Name": "Hello World Agent",
        "Address": "agent@company.com",
        "RoutingType": null,
        "MailboxType": null,
        "Id": null
      }
    ],
    "CcRecipients": [],
    "TextBody": {
      "BodyType": 1,
      "Text": "What is GDPR law?"
    },
    "Body": {
      "BodyType": 0,
      "Text": "What is GDPR law?"
    },
    "ItemClass": "IPM.Note"
  }
}
```

## Processing Logic

### Without Webhook URL (null or empty)
- Email messages are processed directly by the agent logic service
- Uses the existing `NewMessageReceived` method
- Response is generated using the configured AI agent

### With Webhook URL (configured)
- Email messages are converted to Activity Protocol format
- HTTP POST request is sent to the webhook URL with JSON payload
- Request includes proper Content-Type header (application/json)
- Timeout configurable via `Webhook:TimeoutSeconds` (default: 30 seconds)

## Configuration Options

Add to `appsettings.json` or environment variables:

```json
{
  "Webhook": {
    "TimeoutSeconds": 30
  }
}
```

## Error Handling

- Webhook timeouts are logged as warnings
- Failed webhook requests are logged with response status and body
- The background service continues processing other messages even if webhook fails
- No retry logic is implemented (webhook endpoint should handle retries if needed)

## Logging

The system logs:
- When webhook processing is chosen vs direct processing
- Successful webhook deliveries with status codes
- Failed webhook attempts with error details
- Timeout scenarios
