namespace ProcurementA365Agent.AgentLogic.Tools
{
    using System.ComponentModel;
    using ProcurementA365Agent.Models;
    using ProcurementA365Agent.Services;
    using OpenAI.Chat;

    /// <summary>
    /// Email tool for OpenAI function calling that enables sending emails through the agent.
    /// </summary>
    public class OpenAIEmailTool
    {
        private readonly IAgentMessagingService _emailService;
        private readonly AgentMetadata agentMetadataMetadata;
        private readonly ILogger _logger;

        public OpenAIEmailTool(IAgentMessagingService emailService, AgentMetadata agentMetadata, ILogger logger)
        {
            _emailService = emailService ?? throw new ArgumentNullException(nameof(emailService));
            agentMetadataMetadata = agentMetadata ?? throw new ArgumentNullException(nameof(agentMetadata));
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        }

        /// <summary>
        /// Send an email to a specific recipient
        /// </summary>
        /// <param name="toEmail">The email address to send to</param>
        /// <param name="subject">The email subject</param>
        /// <param name="body">The email body content</param>
        /// <returns>A confirmation message</returns>
        [Description("Send an email to a specific recipient")]
        public async Task<string> SendEmailAsync(
            [Description("The email address to send to")] string toEmail,
            [Description("The email subject")] string subject,
            [Description("The email body content")] string body)
        {
            try
            {
                await _emailService.SendEmailAsync(agentMetadataMetadata, toEmail, subject, body);
                _logger.LogInformation("Email sent successfully to {ToEmail} with subject {Subject}", toEmail, subject);
                return $"Email sent successfully to {toEmail} with subject '{subject}'";
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to send email to {ToEmail}", toEmail);
                return $"Failed to send email to {toEmail}: {ex.Message}";
            }
        }

        /// <summary>
        /// Creates a ChatTool instance for this email tool
        /// </summary>
        /// <returns>A ChatTool configured for email functionality</returns>
        public static ChatTool CreateChatTool()
        {
            return ChatTool.CreateFunctionTool(
                functionName: nameof(SendEmailAsync),
                functionDescription: "Send an email to a specific recipient",
                functionParameters: BinaryData.FromString("""
                {
                    "type": "object",
                    "properties": {
                        "toEmail": {
                            "type": "string",
                            "description": "The email address to send to"
                        },
                        "subject": {
                            "type": "string", 
                            "description": "The email subject"
                        },
                        "body": {
                            "type": "string",
                            "description": "The email body content"
                        }
                    },
                    "required": ["toEmail", "subject", "body"]
                }
                """)
            );
        }
    }
}
