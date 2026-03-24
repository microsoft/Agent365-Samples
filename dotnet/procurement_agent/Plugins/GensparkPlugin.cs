namespace ProcurementA365Agent.Plugins;

using Microsoft.Agents.A365.Observability.Runtime.Tracing.Contracts;
using Microsoft.Agents.A365.Observability.Runtime.Tracing.Scopes;
using Microsoft.Extensions.Configuration;
using Microsoft.SemanticKernel;
using Microsoft.SemanticKernel.ChatCompletion;
using ProcurementA365Agent.Models;
using System.ComponentModel;
using System.Text.Json;
using System.Text.RegularExpressions;

/// <summary>
/// Plugin for Genspark to research suppliers and provide advice.
/// </summary>
public sealed class GensparkPlugin(AgentMetadata agent, Kernel kernel, ILogger<GensparkPlugin> logger, IConfiguration configuration)
{
    [KernelFunction, Description("Performs research on suppliers using historical data with Genspark.")]
    public async Task<string> ResearchSuppliers(string suppliersInfo, string itemName, int quantity)
    {
        var toolDetails = new ToolCallDetails(
            toolName: "Genspark Research Suppliers",
            arguments: null);

        var agentDetails = new AgentDetails(
            agentId: agent.AgentId.ToString(),
            agentName: "Genspark");

        var tenantDetails = new TenantDetails(agent.TenantId);
        using var toolScope = ExecuteToolScope.Start(
                            toolDetails,
                            agentDetails,
                            tenantDetails);

        logger.LogInformation(
            "Researching Suppliers using Genspark - Agent: {AgentId}, Item: {ItemName}, Quantity: {Quantity}",
            agent.AgentId, itemName, quantity);
        
        // Get the adaptive card JSON for the supplier data
        var adaptiveCardJson = await GetAdaptiveCardForData(
            kernel, 
            $"Supplier research for {itemName} (quantity: {quantity}): {suppliersInfo}"
        );
        
        logger.LogDebug("Generated adaptive card JSON: {Json}", adaptiveCardJson);
        
        return adaptiveCardJson;
    }

    private const string Instructions = """
        You are an expert at creating Microsoft Adaptive Cards for procurement data visualization.
        
        When given data about suppliers, create an adaptive card that displays the information in a clear, professional format.
        
        CRITICAL REQUIREMENTS:
        1. Return ONLY the raw JSON of the adaptive card - no markdown, no code fences, no explanations
        2. The JSON must be valid and properly formatted
        3. Do NOT wrap the JSON in ```json or any other markdown formatting
        4. Start your response directly with the opening brace {
        5. Use "type": "AdaptiveCard" and "version": "1.4"
        6. Include a title "Supplier Research Analysis"
        7. Display supplier information in a ColumnSet for side-by-side comparison
        8. Use FactSet to show metrics like on-time delivery, lead time, pricing, etc.
        
        Example structure (but adapt to the actual data provided):
        {
          "type": "AdaptiveCard",
          "version": "1.4",
          "body": [
            {
              "type": "TextBlock",
              "text": "Supplier Research Analysis",
              "weight": "Bolder",
              "size": "Large"
            },
            {
              "type": "ColumnSet",
              "columns": [...]
            }
          ]
        }
        """;

    [KernelFunction]
    public async Task<string> GetAdaptiveCardForData(Kernel kernel, string data)
    {
        try
        {
            // Create a chat history with the instructions as a system message and the data as a user message
            ChatHistory chat = new(Instructions);
            chat.Add(new ChatMessageContent(AuthorRole.User, $"Create an adaptive card for this supplier data: {data}"));

            // Invoke the model to get a response
            var chatCompletion = kernel.GetRequiredService<IChatCompletionService>();
            var response = await chatCompletion.GetChatMessageContentAsync(chat);
            
            var responseText = response.ToString();
            
            // Clean up the response to extract only the JSON
            var cleanedJson = ExtractAndCleanJson(responseText);
            
            // Validate that it's actually valid JSON
            try
            {
                using var doc = JsonDocument.Parse(cleanedJson);
                
                // Ensure it has the required adaptive card structure
                if (doc.RootElement.TryGetProperty("type", out var typeProperty) && 
                    typeProperty.GetString() == "AdaptiveCard")
                {
                    logger.LogDebug("Successfully generated valid Adaptive Card JSON");
                    return cleanedJson;
                }
                else
                {
                    logger.LogWarning("Generated JSON is not a valid Adaptive Card, missing type property");
                }
            }
            catch (JsonException ex)
            {
                logger.LogError(ex, "Generated response is not valid JSON: {Response}", responseText);
            }
            
            // Fallback: return a simple adaptive card with the raw data
            logger.LogWarning("Falling back to default adaptive card format");
            return CreateFallbackAdaptiveCard(data);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error generating adaptive card");
            return CreateFallbackAdaptiveCard(data);
        }
    }
    
    /// <summary>
    /// Extracts JSON from the response, removing markdown code fences and other formatting.
    /// </summary>
    private string ExtractAndCleanJson(string response)
    {
        // Remove markdown code fences (```json ... ``` or ``` ... ```
        var jsonMatch = Regex.Match(response, @"```(?:json)?\s*(\{.*?\})\s*```", RegexOptions.Singleline);
        if (jsonMatch.Success)
        {
            logger.LogDebug("Extracted JSON from markdown code fence");
            return jsonMatch.Groups[1].Value.Trim();
        }
        
        // Try to find JSON object boundaries
        var startIndex = response.IndexOf('{');
        var lastIndex = response.LastIndexOf('}');
        
        if (startIndex >= 0 && lastIndex > startIndex)
        {
            logger.LogDebug("Extracted JSON by finding object boundaries");
            return response.Substring(startIndex, lastIndex - startIndex + 1).Trim();
        }
        
        // Return as-is if no JSON found
        logger.LogWarning("Could not extract JSON from response, returning as-is");
        return response.Trim();
    }
    
    /// <summary>
    /// Creates a simple fallback adaptive card when the LLM fails to generate valid JSON.
    /// </summary>
    private string CreateFallbackAdaptiveCard(string data)
    {
        var fallbackCard = new
        {
            type = "AdaptiveCard",
            version = "1.4",
            body = new object[]
            {
                new
                {
                    type = "TextBlock",
                    text = "Supplier Research Analysis",
                    weight = "Bolder",
                    size = "Large"
                },
                new
                {
                    type = "TextBlock",
                    text = data,
                    wrap = true
                }
            }
        };
        
        return JsonSerializer.Serialize(fallbackCard, new JsonSerializerOptions 
        { 
            WriteIndented = false 
        });
    }
}
