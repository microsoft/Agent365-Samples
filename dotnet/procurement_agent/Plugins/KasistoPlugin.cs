namespace ProcurementA365Agent.Plugins;

using ProcurementA365Agent.Models;
using Microsoft.SemanticKernel;
using Microsoft.Extensions.Configuration;
using System.ComponentModel;

/// <summary>
/// Plugin for budget validation and payment advice through Kasisto financial intelligence.
/// 
/// This plugin provides budget checking, payment term analysis, and treasury recommendations
/// for procurement decisions, integrating with financial systems and vendor master data.
/// </summary>
public sealed class KasistoPlugin(AgentMetadata agent, ILogger<KasistoPlugin> logger, IConfiguration configuration)
{
    /// <summary>
    /// Validates budget availability and provides payment advice for the selected supplier and purchase.
    /// </summary>
    /// <param name="itemName">The name of the item being purchased (e.g., 'laptop', 'office chair', 'printer')</param>
    /// <param name="quantity">The quantity being purchased</param>
    /// <param name="unitPrice">The unit price from the selected supplier</param>
    /// <param name="supplierName">The name of the selected supplier</param>
    /// <param name="poNumber">The purchase order number for reference (optional)</param>
    [KernelFunction, Description("Validates budget availability and provides payment advice including discount opportunities and treasury recommendations.")]
    public async Task<string> ValidateBudgetAndPaymentAdviceAsync( // set defaults for now
        [Description("The name of the item being purchased (e.g., 'laptop', 'office chair', 'printer')")]
        string itemName = "laptop",
        [Description("The quantity being purchased (e.g., 4, 10, 25)")]
        int quantity = 4,
        [Description("The unit price from the selected supplier")]
        decimal unitPrice = 300,
        [Description("The name of the selected supplier")]
        string supplierName = "Supplier A",
        [Description("The purchase order number for reference (optional)")]
        string poNumber = "")
    {
        try
        {
            logger.LogInformation(
                "Kasisto budget validation requested - Agent: {AgentId}, Item: {ItemName}, Quantity: {Quantity}, Supplier: {Supplier}",
                agent.AgentId, itemName, quantity, supplierName);

            // Validate input parameters
            if (string.IsNullOrWhiteSpace(itemName))
                return "Error: Item name is required for budget validation.";

            if (quantity <= 0)
                return "Error: Quantity must be greater than 0.";

            if (unitPrice <= 0)
                return "Error: Unit price must be greater than 0.";

            if (string.IsNullOrWhiteSpace(supplierName))
                return "Error: Supplier name is required for payment advice.";

            // Calculate total amount
            var totalAmount = quantity * unitPrice;

            // Get budget information based on item category
            var budgetInfo = GetBudgetInformation(itemName);

            // Get payment terms and advice
            var paymentAdvice = GetPaymentAdvice(supplierName, totalAmount);

            // Perform budget check
            var budgetStatus = PerformBudgetCheck(budgetInfo, totalAmount, poNumber);

            // Format the response
            var response = FormatBudgetAndPaymentResponse(budgetInfo, budgetStatus, paymentAdvice, totalAmount);

            logger.LogInformation(
                "Kasisto budget validation completed - Agent: {AgentId}, Status: {Status}, Total: ${Amount:F2}",
                agent.AgentId, budgetStatus.Status, totalAmount);

            return response;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error in Kasisto budget validation for agent {AgentId}", agent.AgentId);
            return $"Error performing budget validation and payment advice: {ex.Message}";
        }
    }

    /// <summary>
    /// Gets budget information based on the item category.
    /// </summary>
    /// <param name="itemName">The item name to categorize</param>
    /// <returns>Budget information for the category</returns>
    private BudgetInfo GetBudgetInformation(string itemName)
    {
        return itemName.ToLower() switch
        {
            "laptop" or "laptops" or "computer" or "desktop" or "monitor" => new BudgetInfo
            {
                Category = "Hardware (IT-HW-2025)",
                TotalBudget = 10000,
                CommittedAmount = 4800,
                BudgetCode = "IT-HW-2025"
            },
            "office chair" or "chair" or "chairs" or "desk" or "furniture" => new BudgetInfo
            {
                Category = "Office Furniture (OFF-FUR-2025)",
                TotalBudget = 15000,
                CommittedAmount = 7200,
                BudgetCode = "OFF-FUR-2025"
            },
            "printer" or "printers" or "scanner" or "copier" => new BudgetInfo
            {
                Category = "Office Equipment (OFF-EQ-2025)",
                TotalBudget = 8000,
                CommittedAmount = 3500,
                BudgetCode = "OFF-EQ-2025"
            },
            "software" or "license" or "subscription" => new BudgetInfo
            {
                Category = "Software & Licenses (IT-SW-2025)",
                TotalBudget = 25000,
                CommittedAmount = 12000,
                BudgetCode = "IT-SW-2025"
            },
            _ => new BudgetInfo
            {
                Category = "General Procurement (GEN-PROC-2025)",
                TotalBudget = 20000,
                CommittedAmount = 8500,
                BudgetCode = "GEN-PROC-2025"
            }
        };
    }

    /// <summary>
    /// Gets payment advice based on supplier and amount.
    /// </summary>
    /// <param name="supplierName">The supplier name</param>
    /// <param name="totalAmount">The total purchase amount</param>
    /// <returns>Payment advice information</returns>
    private PaymentAdvice GetPaymentAdvice(string supplierName, decimal totalAmount)
    {
        // Mock vendor payment terms based on supplier type
        var paymentTerms = supplierName.ToLower() switch
        {
            var name when name.Contains("supplier a") || name.Contains("dell") || name.Contains("hp") => "2%/10 Net-30",
            var name when name.Contains("supplier b") || name.Contains("lenovo") || name.Contains("microsoft") => "1%/15 Net-45",
            var name when name.Contains("ergosupply") || name.Contains("office") => "1.5%/10 Net-30",
            var name when name.Contains("techprint") || name.Contains("canon") || name.Contains("xerox") => "2%/10 Net-30",
            _ => "2%/10 Net-30"
        };

        // Calculate potential savings
        var discountRate = paymentTerms switch
        {
            "2%/10 Net-30" => 0.02m,
            "1.5%/10 Net-30" => 0.015m,
            "1%/15 Net-45" => 0.01m,
            _ => 0.02m
        };

        var potentialSavings = totalAmount * discountRate;

        return new PaymentAdvice
        {
            PaymentTerms = paymentTerms,
            DiscountRate = discountRate,
            PotentialSavings = potentialSavings,
            TreasurySupport = true, // Mock treasury policy support
            Recommendation = $"Recommend offering {paymentTerms.Split(' ')[0]} (saves ${potentialSavings:F0})"
        };
    }

    /// <summary>
    /// Performs budget check against available funds.
    /// </summary>
    /// <param name="budgetInfo">Budget information</param>
    /// <param name="requestedAmount">Requested purchase amount</param>
    /// <param name="poNumber">Purchase order number</param>
    /// <returns>Budget check status</returns>
    private BudgetStatus PerformBudgetCheck(BudgetInfo budgetInfo, decimal requestedAmount, string poNumber)
    {
        var availableBudget = budgetInfo.TotalBudget - budgetInfo.CommittedAmount;
        var newCommittedAmount = budgetInfo.CommittedAmount + requestedAmount;

        // Determine status based on budget availability
        var status = requestedAmount <= availableBudget ? "Approved" : "Requires Approval";
        
        // If over budget but within 10% tolerance, mark as conditional
        if (requestedAmount > availableBudget && requestedAmount <= availableBudget * 1.1m)
        {
            status = "Conditional Approval";
        }

        var poReference = string.IsNullOrWhiteSpace(poNumber) ? "this PO" : $"PO-{poNumber}";

        return new BudgetStatus
        {
            Status = status,
            AvailableBudget = availableBudget,
            NewCommittedAmount = newCommittedAmount,
            PoReference = poReference
        };
    }

    /// <summary>
    /// Formats the budget and payment response.
    /// </summary>
    /// <param name="budgetInfo">Budget information</param>
    /// <param name="budgetStatus">Budget check status</param>
    /// <param name="paymentAdvice">Payment advice</param>
    /// <param name="totalAmount">Total purchase amount</param>
    /// <returns>Formatted response</returns>
    private string FormatBudgetAndPaymentResponse(BudgetInfo budgetInfo, BudgetStatus budgetStatus, PaymentAdvice paymentAdvice, decimal totalAmount)
    {
        var response = $"Budget Check — {budgetInfo.Category}\n\n" +
                      $"Budget: ${budgetInfo.TotalBudget:N0}\n\n" +
                      $"Committed (incl. {budgetStatus.PoReference}): ${budgetStatus.NewCommittedAmount:N0}\n\n" +
                      $"Status: {budgetStatus.Status}\n\n" +
                      $"Payment Advice\n\n" +
                      $"Vendor master shows {paymentAdvice.PaymentTerms} terms\n\n" +
                      $"Treasury policy supports early-pay up to {paymentAdvice.DiscountRate:P0} given current cash targets\n\n" +
                      $" → {paymentAdvice.Recommendation}";

        return response;
    }

    #region Helper Classes

    /// <summary>
    /// Represents budget information for a category.
    /// </summary>
    private class BudgetInfo
    {
        public string Category { get; set; } = string.Empty;
        public decimal TotalBudget { get; set; }
        public decimal CommittedAmount { get; set; }
        public string BudgetCode { get; set; } = string.Empty;
    }

    /// <summary>
    /// Represents payment advice and terms.
    /// </summary>
    private class PaymentAdvice
    {
        public string PaymentTerms { get; set; } = string.Empty;
        public decimal DiscountRate { get; set; }
        public decimal PotentialSavings { get; set; }
        public bool TreasurySupport { get; set; }
        public string Recommendation { get; set; } = string.Empty;
    }

    /// <summary>
    /// Represents budget check status.
    /// </summary>
    private class BudgetStatus
    {
        public string Status { get; set; } = string.Empty;
        public decimal AvailableBudget { get; set; }
        public decimal NewCommittedAmount { get; set; }
        public string PoReference { get; set; } = string.Empty;
    }

    #endregion
}