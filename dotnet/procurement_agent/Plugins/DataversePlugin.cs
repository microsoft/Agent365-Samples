namespace ProcurementA365Agent.Plugins;

using System.ComponentModel;
using System.Text.Json;
using ProcurementA365Agent.Models;
using ProcurementA365Agent.Services;
using Microsoft.SemanticKernel;
using Microsoft.Xrm.Sdk;

public sealed class DataversePlugin(DataverseService dataverseService, AgentMetadata agent)
{
    [KernelFunction, Description("Retrieves records from a Dataverse table.")]
    public async Task<string> GetRecords(
        [Description("The logical name of the Dataverse table to query (e.g., 'account', 'contact', 'incident')")] 
        string tableName)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(tableName))
            {
                return "Error: Table name is required.";
            }

            var records = await dataverseService.GetRecordsAsync(agent, tableName);
            
            if (!records.Any())
            {
                return $"No records found in table '{tableName}'.";
            }

            // Convert entities to a simplified format for the AI agent
            var simplifiedRecords = records.Select(entity => new
            {
                Id = entity.Id.ToString(),
                entity.LogicalName,
                Attributes = entity.Attributes.ToDictionary(
                    attr => attr.Key,
                    attr => FormatAttributeValue(attr.Value)
                )
            }).ToArray();

            var result = new
            {
                TableName = tableName,
                RecordCount = simplifiedRecords.Length,
                Records = simplifiedRecords
            };

            return JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true });
        }
        catch (Exception ex)
        {
            return $"Error retrieving records from table '{tableName}': {ex.Message}";
        }
    }

    private static string FormatAttributeValue(object? value) =>
        value switch
        {
            EntityReference entityRef => $"{entityRef.LogicalName}:{entityRef.Id}",
            OptionSetValue optionSet => optionSet.Value.ToString(),
            Money money => money.Value.ToString("C"),
            DateTime dateTime => dateTime.ToString("yyyy-MM-dd HH:mm:ss"),
            DateTimeOffset dateTimeOffset => dateTimeOffset.ToString("yyyy-MM-dd HH:mm:ss zzz"),
            _ => value?.ToString() ?? ""
        };
}