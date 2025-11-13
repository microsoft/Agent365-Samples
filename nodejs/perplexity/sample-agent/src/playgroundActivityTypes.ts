/**
 * Represents the payload for a simulated Word mention activity in the Playground.
 * Includes document URL, user mention details, and optional context snippet.
 */
export interface MentionInWordValue {
  docUrl: string; // URL of the Word document where the mention occurred
  mention: {
    displayName: string; // Display name of the mentioned user
    userPrincipalName: string; // UPN (email) of the mentioned user
  };
  context?: string; // Optional text snippet around the mention
}

/**
 * Represents the payload for a simulated email activity in the Playground.
 * Includes sender, recipients, subject, and body content.
 */
export interface SendEmailActivityValue {
  from: string; // Sender email address
  to: string[]; // Recipient email addresses
  subject: string; // Email subject line
  body: string; // Email body content
}

/**
 * Full structure of a simulated "sendEmail" activity, triggered by the Playground for testing.
 */
export interface SendEmailActivity {
  type: "sendEmail"; // Activity type identifier for Playground
  id: string; // Unique activity ID
  channelId: string; // Channel identifier (e.g., "microsoft365")
  from: {
    id: string; // Sender ID
    aadObjectId: string; // Azure AD object ID of sender
  };
  timestamp: string; // ISO timestamp when activity was created
  serviceUrl: string; // Service URL for the activity
  conversation: {
    conversationType: string; // Type of conversation (e.g., "personal")
    tenantId: string; // Tenant ID for the conversation
    id: string; // Conversation ID
  };
  recipient: {
    id: string; // Recipient ID
    name: string; // Recipient display name
  };
  value: SendEmailActivityValue; // Email details payload
}

/**
 * ✅ PlaygroundActivityTypes
 * Enum of custom activity types used ONLY in the Agents Playground for simulation.
 * These do NOT represent real Microsoft 365 notifications.
 *
 * - MentionInWord: Simulates a Word mention event (custom payload).
 * - SendEmail: Simulates an email notification event (custom payload).
 * - Custom: Generic placeholder for any other simulated activity.
 *
 * Real notifications use AgentNotificationActivity and trigger
 * onAgentNotification/onAgenticWordNotification handlers instead.
 */
export enum PlaygroundActivityTypes {
  MentionInWord = "mentionInWord", // Triggered when simulating a Word mention
  SendEmail = "sendEmail", // Triggered when simulating an email notification
  Custom = "custom", // Triggered for any custom test activity
}
