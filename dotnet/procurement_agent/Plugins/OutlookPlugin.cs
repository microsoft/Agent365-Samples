namespace ProcurementA365Agent.Plugins;

using System.ComponentModel;
using System.Text.Json;
using ProcurementA365Agent.Models;
using ProcurementA365Agent.Services;
using Microsoft.SemanticKernel;

public sealed class OutlookPlugin(
    IAgentMessagingService messagingService, AgentMetadata agent)
{
    /// <summary>
    /// Checks for new emails received since a specified date and time.
    /// </summary>
    /// <param name="sinceDateTime">The date and time to check for new emails since (ISO 8601 format)</param>
    [KernelFunction, Description("Checks for new emails received since a specified date and time.")]
    public async Task<string> CheckForNewEmailsAsync(
        [Description("The date and time to check for new emails since (ISO 8601 format, e.g., '2025-01-15T09:00:00Z')")]
        string sinceDateTime)
    {
        try
        {
            if (!DateTime.TryParse(sinceDateTime, out var parsedDateTime))
            {
                return "Error: Invalid date format. Please use ISO 8601 format (e.g., '2025-01-15T09:00:00Z').";
            }

            var messages = await messagingService.CheckForNewEmailAsync(agent, parsedDateTime);

            if (messages.Length == 0)
            {
                return "No new emails found.";
            }

            var result = new
            {
                Count = messages.Length,
                Messages = messages.Select(m => new
                {
                    Id = m.Id,
                    From = m.From,
                    Subject = m.Subject,
                    ReceivedDateTime = m.ReceivedDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ"),
                    IsRead = m.IsRead,
                    BodyPreview = m.Body.Length > 100 ? m.Body.Substring(0, 100) + "..." : m.Body
                }).ToArray()
            };

            return JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true });
        }
        catch (Exception ex)
        {
            return $"Error checking for new emails: {ex.Message}";
        }
    }

    /// <summary>
    /// Sends an email to a specified recipient.
    /// </summary>
    /// <param name="toEmail">The recipient's email address</param>
    /// <param name="subject">The email subject</param>
    /// <param name="body">The email body content</param>
    [KernelFunction, Description("Sends an email to a specified recipient.")]
    public async Task<string> SendEmailAsync(
        [Description("The recipient's email address or AAD Object Id ")] string toEmail,
        [Description("The email subject")] string subject,
        [Description("The email body content")] string body)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(toEmail))
            {
                return "Error: Recipient email address is required.";
            }

            if (string.IsNullOrWhiteSpace(subject))
            {
                return "Error: Email subject is required.";
            }

            if (string.IsNullOrWhiteSpace(body))
            {
                return "Error: Email body is required.";
            }

            if (!IsValidEmail(toEmail))
            {
                return "Error: Invalid email address format.";
            }

            await messagingService.SendEmailAsync(agent, toEmail, subject, body);

            return $"Email successfully sent to {toEmail} with subject '{subject}'.";
        }
        catch (Exception ex)
        {
            return $"Error sending email: {ex.Message}";
        }
    }

    /// <summary>
    /// Gets a summary of recent email activity.
    /// </summary>
    /// <param name="days">Number of days to look back for email activity (default: 7)</param>
    [KernelFunction, Description("Gets a summary of recent email activity for the agent.")]
    public async Task<string> GetEmailSummaryAsync(
        [Description("Number of days to look back for email activity (default: 7)")] int days = 7)
    {
        try
        {
            if (days <= 0)
            {
                return "Error: Number of days must be greater than 0.";
            }

            var sinceDateTime = DateTime.UtcNow.AddDays(-days);
            var messages = await messagingService.CheckForNewEmailAsync(agent, sinceDateTime);

            if (messages.Length == 0)
            {
                return $"No emails found in the last {days} day(s).";
            }

            var unreadCount = messages.Count(m => !m.IsRead);
            var totalCount = messages.Length;

            var summary = new
            {
                Period = $"Last {days} day(s)",
                TotalEmails = totalCount,
                UnreadEmails = unreadCount,
                ReadEmails = totalCount - unreadCount,
                MostRecentEmail = messages.OrderByDescending(m => m.ReceivedDateTime).FirstOrDefault()?.ReceivedDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ"),
                TopSenders = messages.GroupBy(m => m.From)
                                   .OrderByDescending(g => g.Count())
                                   .Take(5)
                                   .Select(g => new { Email = g.Key, Count = g.Count() })
                                   .ToArray()
            };

            return JsonSerializer.Serialize(summary, new JsonSerializerOptions { WriteIndented = true });
        }
        catch (Exception ex)
        {
            return $"Error getting email summary: {ex.Message}";
        }
    }
    
    private static bool IsValidEmail(string email)
    {
        try
        {
            var addr = new System.Net.Mail.MailAddress(email);
            return addr.Address == email;
        }
        catch
        {
            return false;
        }
    }
}