namespace ProcurementA365Agent.Plugins;

using Microsoft.Agents.A365.Observability.Runtime.Tracing.Contracts;
using Microsoft.Agents.A365.Observability.Runtime.Tracing.Scopes;
using Microsoft.Extensions.Configuration;
using Microsoft.SemanticKernel;
using ProcurementA365Agent.Models;
using ProcurementA365Agent.Services;
using System.ComponentModel;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;

/// <summary>
/// Plugin for interacting with SAP S/4HANA to manage purchase orders.
/// 
/// In production, this would integrate with SAP S/4HANA OData APIs:
/// - API_PURCHASEORDER_PROCESS_SRV for PO operations
/// - Authentication via OAuth 2.0 or certificate-based auth
/// - Requires SAP NetWeaver Gateway or SAP Cloud Platform connectivity
/// </summary>
public sealed class SAPPlugin(AgentMetadata agent, Kernel kernel, ILogger<SAPPlugin> logger, IConfiguration configuration)
{
    /// <summary>
    /// Creates a new purchase order by finding approved suppliers for the requested items.
    /// Automatically invokes another agent to research suppliers and provides supplier options.
    /// Sends real-time updates to the user's chat for each step by editing a single message.
    /// </summary>
    /// <param name="itemName">The name of the item to purchase (e.g., 'laptop', 'office chair', 'printer')</param>
    /// <param name="quantity">The quantity needed</param>
    /// <param name="shipToAddress">The shipping address for delivery</param>
    /// <param name="billToAddress">The billing address for invoicing</param>
    /// <param name="chatId">Optional chat ID to send progress updates to</param>
    [KernelFunction, Description("Record purchase order to database, so we can track what customer asked.")]
    public async Task<string> AcceptPurchaseOrderAsync(
        [Description("The name of the item to purchase (e.g., 'laptop', 'office chair', 'printer')")]
        string itemName,
        [Description("The quantity needed (e.g., 4, 10, 25)")]
        int quantity,
        [Description("The shipping address for delivery")]
        string shipToAddress,
        [Description("The billing address for invoicing")]
        string billToAddress)
    {
        var toolDetails = new ToolCallDetails(
            toolName: "Accept Purchase Order",
            arguments: null);

        var agentDetails = new AgentDetails(
            agentId: agent.AgentId.ToString(),
            agentName: agent.AgentFriendlyName);

        var tenantDetails = new TenantDetails(agent.TenantId);

        using var toolScope = ExecuteToolScope.Start(
                            toolDetails,
                            agentDetails,
                            tenantDetails);

        try
        {
            // Step 0: Validate required parameters
            if (string.IsNullOrWhiteSpace(itemName))
                return "Error: Item name is required.";

            if (quantity <= 0)
                return "Error: Quantity must be greater than 0.";

            if (string.IsNullOrWhiteSpace(shipToAddress))
                return "Error: Ship-to address is required.";

            if (string.IsNullOrWhiteSpace(billToAddress))
                return "Error: Bill-to address is required.";

            logger.LogInformation(
                "Accepting Purchase Order - Agent: {AgentId}, Item: {ItemName}, Quantity: {Quantity}",
                agent.AgentId, itemName, quantity);

            // Find suppliers
            var suppliersToolCallDetails = new ToolCallDetails(
            toolName: "Find Suppliers",
            arguments: null);
            using var suppliersToolScope = ExecuteToolScope.Start(
                            suppliersToolCallDetails,
                            agentDetails,
                            tenantDetails);

            Random random = new Random();
            // Return summary for the agent
            return $"Purchase order recieved for {itemName} and {quantity} order number is {random.Next(100000, 999999)}:\n\n";
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error accepting purchase order for agent {AgentId}", agent.AgentId);
            return $"Error finding suppliers: {ex.Message}";
        }
    }

    /// <summary>
    /// Creates the final purchase order with a selected supplier.
    /// </summary>
    /// <param name="supplierName">The selected supplier name</param>
    /// <param name="orderNumber">The order number from AcceptPurchaseOrder</param>
    /// <param name="itemName">The name of the item to purchase</param>
    /// <param name="quantity">The quantity needed</param>
    /// <param name="shipToAddress">The shipping address for delivery</param>
    /// <param name="billToAddress">The billing address for invoicing</param>
    [KernelFunction, Description("Creates the final purchase order with a selected supplier. Requires supplier name and order number from previous steps.")]
    public async Task<string> FulfillPurchaseOrderAsync(
        [Description("The selected supplier name (e.g., 'Supplier A', 'Supplier B', 'ErgoSupply Co')")]
        string supplierName,
        [Description("The order number received from AcceptPurchaseOrder (e.g., '123456')")]
        string orderNumber,
        [Description("The name of the item to purchase (e.g., 'laptop', 'office chair', 'printer')")]
        string itemName,
        [Description("The quantity needed (e.g., 4, 10, 25)")]
        int quantity,
        [Description("The shipping address for delivery")]
        string shipToAddress,
        [Description("The billing address for invoicing")]
        string billToAddress)
    {
        var fulfillmentToolDetails = new ToolCallDetails(
            toolName: "Fulfill Purchase Order",
            arguments: null);

        var agentDetails = new AgentDetails(
            agentId: agent.AgentId.ToString(),
            agentName: agent.AgentFriendlyName);

        var tenantDetails = new TenantDetails(agent.TenantId);

        using var fulfillmentToolScope = ExecuteToolScope.Start(
            fulfillmentToolDetails,
            agentDetails,
            tenantDetails);

        try
        {
            // Validate parameters
            if (string.IsNullOrWhiteSpace(supplierName))
                return "Error: Supplier name is required.";

            if (string.IsNullOrWhiteSpace(orderNumber))
                return "Error: Order number is required.";

            if (string.IsNullOrWhiteSpace(itemName))
                return "Error: Item name is required.";

            if (quantity <= 0)
                return "Error: Quantity must be greater than 0.";

            if (string.IsNullOrWhiteSpace(shipToAddress))
                return "Error: Ship-to address is required.";

            if (string.IsNullOrWhiteSpace(billToAddress))
                return "Error: Bill-to address is required.";

            logger.LogInformation(
                "Fulfilling purchase order - Supplier: {SupplierName}, Order: {OrderNumber}, Item: {ItemName}, Quantity: {Quantity}",
                supplierName, orderNumber, itemName, quantity);

            // Get supplier details
            var selectedSupplier = GetSelectedSupplierDetails(supplierName, itemName);
            if (selectedSupplier == null)
            {
                return $"Error: Could not find supplier '{supplierName}' for item '{itemName}'. Please verify the supplier name.";
            }

            // Calculate totals
            var deliveryDate = DateTime.Now.AddDays(selectedSupplier.EtaDays);
            var totalAmount = selectedSupplier.UnitPrice * quantity;

            var poNumber = $"45{DateTime.Now.Ticks % 100000000:D8}";

            logger.LogInformation("Purchase Order #{PONumber} created for order {OrderNumber}", poNumber, orderNumber);

            // Determine SLA compliance
            var slaCompliance = selectedSupplier.EtaDays <= 7 ? "Within SLA" : "Outside SLA";

            // Return confirmation
            return $"Purchase order #{poNumber} created successfully for order {orderNumber}.\n\n" +
                   $"Supplier: {selectedSupplier.Name}\n" +
                   $"Item: {quantity} {itemName}(s)\n" +
                   $"Total: ${totalAmount:N2}\n" +
                   $"Delivery: {deliveryDate:yyyy-MM-dd} ({selectedSupplier.EtaDays} days)\n" +
                   $"SLA Status: {slaCompliance}\n" +
                   $"Ship To: {shipToAddress}\n" +
                   $"Bill To: {billToAddress}";
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error fulfilling purchase order for agent {AgentId}", agent.AgentId);
            return $"Error fulfilling purchase order: {ex.Message}";
        }
    }

    /// <summary>
    /// Generates mock supplier data based on the item type.
    /// </summary>
    private List<SupplierOption> GenerateMockSuppliers(string itemName, int quantity)
    {
        var suppliers = new List<SupplierOption>();

        // Generate supplier data based on item type
        switch (itemName.ToLower())
        {
            case "laptop":
            case "laptops":
                suppliers.Add(new SupplierOption
                {
                    Name = "Supplier A",
                    UnitPrice = 1200,
                    EtaDays = 5,
                    OnTimePercentage = 98
                });
                suppliers.Add(new SupplierOption
                {
                    Name = "Supplier B",
                    UnitPrice = 1150,
                    EtaDays = 8,
                    OnTimePercentage = 90
                });
                break;

            case "office chair":
            case "chair":
            case "chairs":
                suppliers.Add(new SupplierOption
                {
                    Name = "ErgoSupply Co",
                    UnitPrice = 450,
                    EtaDays = 3,
                    OnTimePercentage = 96
                });
                suppliers.Add(new SupplierOption
                {
                    Name = "Office Solutions",
                    UnitPrice = 420,
                    EtaDays = 6,
                    OnTimePercentage = 92
                });
                break;

            case "printer":
            case "printers":
                suppliers.Add(new SupplierOption
                {
                    Name = "TechPrint Pro",
                    UnitPrice = 350,
                    EtaDays = 4,
                    OnTimePercentage = 94
                });
                suppliers.Add(new SupplierOption
                {
                    Name = "Office Express",
                    UnitPrice = 325,
                    EtaDays = 7,
                    OnTimePercentage = 88
                });
                break;

            default:
                // Generic suppliers for other items
                suppliers.Add(new SupplierOption
                {
                    Name = "Supplier A",
                    UnitPrice = 100,
                    EtaDays = 5,
                    OnTimePercentage = 95
                });
                suppliers.Add(new SupplierOption
                {
                    Name = "Supplier B",
                    UnitPrice = 95,
                    EtaDays = 7,
                    OnTimePercentage = 92
                });
                break;
        }

        return suppliers;
    }

    /// <summary>
    /// Gets the policy note based on item type.
    /// </summary>
    private string GetPolicyNote(string itemName)
    {
        return itemName.ToLower() switch
        {
            "laptop" or "laptops" => "Policy note: Laptop SLA ≤ 7 days",
            "office chair" or "chair" or "chairs" => "Policy note: Furniture delivery SLA ≤ 10 days",
            "printer" or "printers" => "Policy note: IT equipment SLA ≤ 5 days",
            _ => "Policy note: Standard procurement SLA ≤ 7 days"
        };
    }

    /// <summary>
    /// Finalizes the purchase order by creating it in SAP with the selected supplier.
    /// </summary>
    /// <param name="supplierName">The selected supplier name (e.g., 'Supplier A', 'Supplier B')</param>
    /// <param name="itemName">The name of the item being purchased</param>
    /// <param name="quantity">The quantity being purchased</param>
    /// <param name="shipToAddress">The shipping address for delivery</param>
    /// <param name="billToAddress">The billing address for invoicing</param>
    [KernelFunction, Description("Proceeds with the purchase order for the selected supplier.")]
    public async Task<string> ProceedWithPurchaseOrderAsync( // set defaults for now
        [Description("The selected supplier name (e.g., 'Supplier A', 'Supplier B', 'ErgoSupply Co')")]
        string supplierName,
        [Description("The name of the item being purchased (e.g., 'laptop', 'office chair', 'printer')")]
        string itemName = "laptop",
        [Description("The quantity being purchased (e.g., 4, 10, 25)")]
        int quantity = 4,
        [Description("The shipping address for delivery")]
        string shipToAddress = "Zava HQ, 123 Innovation Drive, Seattle, WA 98101",
        [Description("The billing address for invoicing")]
        string billToAddress = "Cost Center IT-HW-2025")
    {
        try
        {
            logger.LogInformation(
                "Finalizing Purchase Order - Agent: {AgentId}, Supplier: {Supplier}, Item: {ItemName}, Quantity: {Quantity}",
                agent.AgentId, supplierName, itemName, quantity);

            // Validate input parameters
            if (string.IsNullOrWhiteSpace(supplierName))
                return "Error: Supplier name is required to finalize the purchase order.";

            if (string.IsNullOrWhiteSpace(itemName))
                return "Error: Item name is required.";

            if (quantity <= 0)
                return "Error: Quantity must be greater than 0.";

            if (string.IsNullOrWhiteSpace(shipToAddress))
                return "Error: Ship-to address is required.";

            if (string.IsNullOrWhiteSpace(billToAddress))
                return "Error: Bill-to address is required.";

            // Get supplier details based on selection
            var selectedSupplier = GetSelectedSupplierDetails(supplierName, itemName);
            if (selectedSupplier == null)
            {
                return $"Error: Could not find supplier '{supplierName}' for item '{itemName}'. Please check the supplier name.";
            }

            // Calculate totals
            var totalAmount = selectedSupplier.UnitPrice * quantity;
            var deliveryDate = DateTime.Now.AddDays(selectedSupplier.EtaDays);

            // Generate mock PO number
            var poNumber = $"45{DateTime.Now.Ticks % 100000000:D8}";

            // Create mock PO items for SAP integration
            var poItems = new List<PurchaseOrderItem>
            {
                new PurchaseOrderItem
                {
                    MaterialId = GenerateMaterialId(itemName),
                    Quantity = quantity,
                    UnitPrice = selectedSupplier.UnitPrice,
                    Plant = "1000", // Default plant
                    DeliveryDate = deliveryDate.ToString("yyyy-MM-dd")
                }
            };

            // Mock SAP PO creation
            var sapPoNumber = await CreatePurchaseOrderInSAPAsync(
                GetSupplierCode(supplierName),
                "1000", // Purchasing organization
                "P01",  // Purchasing group
                "1000", // Company code
                DateTime.Now,
                poItems);

            // Format success response
            var response = FormatPurchaseOrderConfirmation(
                sapPoNumber,
                selectedSupplier,
                itemName,
                quantity,
                totalAmount,
                deliveryDate,
                shipToAddress,
                billToAddress);

            logger.LogInformation(
                "Purchase Order finalized - Agent: {AgentId}, PO Number: {PONumber}, Supplier: {Supplier}, Total: ${Total:F2}",
                agent.AgentId, sapPoNumber, supplierName, totalAmount);

            return response;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error finalizing purchase order for agent {AgentId}", agent.AgentId);
            return $"Error finalizing purchase order: {ex.Message}";
        }
    }

    /// <summary>
    /// Gets the selected supplier details based on supplier name and item type.
    /// </summary>
    /// <param name="supplierName">The supplier name</param>
    /// <param name="itemName">The item name</param>
    /// <returns>Supplier details or null if not found</returns>
    private SupplierOption? GetSelectedSupplierDetails(string supplierName, string itemName)
    {
        var suppliers = GenerateMockSuppliers(itemName, 1); // Quantity doesn't matter for lookup
        return suppliers.FirstOrDefault(s =>
            string.Equals(s.Name, supplierName, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// Generates a material ID based on item name.
    /// </summary>
    /// <param name="itemName">The item name</param>
    /// <returns>Mock material ID</returns>
    private string GenerateMaterialId(string itemName)
    {
        return itemName.ToLower() switch
        {
            "laptop" or "laptops" => "MAT-LAPTOP-001",
            "office chair" or "chair" or "chairs" => "MAT-CHAIR-001",
            "printer" or "printers" => "MAT-PRINTER-001",
            _ => "MAT-GENERAL-001"
        };
    }

    /// <summary>
    /// Gets supplier code for SAP integration.
    /// </summary>
    /// <param name="supplierName">The supplier name</param>
    /// <returns>SAP supplier code</returns>
    private string GetSupplierCode(string supplierName)
    {
        return supplierName.ToLower() switch
        {
            var name when name.Contains("supplier a") => "VENDOR_A_001",
            var name when name.Contains("supplier b") => "VENDOR_B_001",
            var name when name.Contains("ergosupply") => "VENDOR_ERGO_001",
            var name when name.Contains("office solutions") => "VENDOR_OFFICE_001",
            var name when name.Contains("techprint") => "VENDOR_TECH_001",
            var name when name.Contains("office express") => "VENDOR_EXPRESS_001",
            _ => "VENDOR_GENERIC_001"
        };
    }

    /// <summary>
    /// Formats the purchase order confirmation response.
    /// </summary>
    /// <param name="poNumber">Generated PO number</param>
    /// <param name="supplier">Selected supplier details</param>
    /// <param name="itemName">Item name</param>
    /// <param name="quantity">Quantity</param>
    /// <param name="totalAmount">Total amount</param>
    /// <param name="deliveryDate">Expected delivery date</param>
    /// <param name="shipToAddress">Shipping address</param>
    /// <param name="billToAddress">Billing address</param>
    /// <returns>Formatted confirmation message</returns>
    private string FormatPurchaseOrderConfirmation(
        string poNumber,
        SupplierOption supplier,
        string itemName,
        int quantity,
        decimal totalAmount,
        DateTime deliveryDate,
        string shipToAddress,
        string billToAddress)
    {
        // Convert PO number format to PO-#### format
        var formattedPoNumber = $"Purchase Order #{poNumber}";

        // Determine SLA compliance
        var slaCompliance = CheckSLACompliance(itemName, supplier.EtaDays);

        // Format item name with proper pluralization
        var itemDisplay = quantity == 1 ? itemName : $"{itemName}s";

        return $"{formattedPoNumber} created for {quantity} {itemDisplay} from {supplier.Name}.\n\nETA: {supplier.EtaDays} days ({slaCompliance}).";
    }

    /// <summary>
    /// Checks if the delivery time meets SLA requirements.
    /// </summary>
    /// <param name="itemName">The item name</param>
    /// <param name="etaDays">Estimated delivery days</param>
    /// <returns>SLA compliance status</returns>
    private string CheckSLACompliance(string itemName, int etaDays)
    {
        var slaRequirement = itemName.ToLower() switch
        {
            "laptop" or "laptops" => 7,
            "office chair" or "chair" or "chairs" => 10,
            "printer" or "printers" => 5,
            _ => 7
        };

        return etaDays <= slaRequirement ? "meets SLA" : "exceeds SLA";
    }

    /// <summary>
    /// Retrieves purchase order details from SAP S/4HANA.
    /// </summary>
    /// <param name="purchaseOrderNumber">The purchase order number to retrieve</param>
    [KernelFunction, Description("Retrieves details of a purchase order from SAP S/4HANA by PO number.")]
    public async Task<string> GetPurchaseOrderAsync(
        [Description("The purchase order number to retrieve (e.g., '4500012345')")]
        string purchaseOrderNumber)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(purchaseOrderNumber))
                return "Error: Purchase order number is required.";

            logger.LogInformation(
                "Retrieving SAP Purchase Order - Agent: {AgentId}, PO Number: {PONumber}",
                agent.AgentId, purchaseOrderNumber);

            var poDetails = await GetPurchaseOrderFromSAPAsync(purchaseOrderNumber);

            if (poDetails == null)
                return $"Purchase order {purchaseOrderNumber} not found in SAP.";

            return JsonSerializer.Serialize(poDetails, new JsonSerializerOptions { WriteIndented = true });
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error retrieving SAP purchase order {PONumber} for agent {AgentId}",
                purchaseOrderNumber, agent.AgentId);
            return $"Error retrieving purchase order from SAP: {ex.Message}";
        }
    }

    #region SAP S/4HANA Integration Methods

    /// <summary>
    /// Creates a purchase order in SAP S/4HANA using OData API.
    /// 
    /// Production Implementation Guide:
    /// 1. Endpoint: POST https://{sap-host}/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder
    /// 2. Headers:
    ///    - Authorization: Bearer {token} or Basic {base64credentials}
    ///    - Content-Type: application/json
    ///    - x-csrf-token: {csrf-token} (obtained via GET request first)
    /// 3. Body structure:
    ///    {
    ///      "PurchaseOrderType": "NB",
    ///      "Supplier": "{vendorId}",
    ///      "PurchasingOrganization": "{purchasingOrganization}",
    ///      "PurchasingGroup": "{purchasingGroup}",
    ///      "CompanyCode": "{companyCode}",
    ///      "DocumentDate": "{documentDate}",
    ///      "to_PurchaseOrderItem": [
    ///        {
    ///          "Material": "{materialId}",
    ///          "OrderQuantity": "{quantity}",
    ///          "NetPriceAmount": "{unitPrice}",
    ///          "Plant": "{plant}",
    ///          "ScheduleLine": [
    ///            {
    ///              "DeliveryDate": "{deliveryDate}"
    ///            }
    ///          ]
    ///        }
    ///      ]
    ///    }
    /// 4. Response: Returns created PO number in d/PurchaseOrder field
    /// </summary>
    private async Task<string> CreatePurchaseOrderInSAPAsync(
        string vendorId,
        string purchasingOrganization,
        string purchasingGroup,
        string companyCode,
        DateTime documentDate,
        List<PurchaseOrderItem> items)
    {
        // TODO: Replace with actual SAP S/4HANA API integration
        // 
        // Example using HttpClient:
        // 
        // var sapClient = new HttpClient();
        // sapClient.BaseAddress = new Uri("https://your-sap-host.com");
        // sapClient.DefaultRequestHeaders.Authorization = 
        //     new AuthenticationHeaderValue("Bearer", await GetSAPTokenAsync());
        //
        // // First, get CSRF token
        // var csrfResponse = await sapClient.GetAsync(
        //     "/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV/",
        //     new HttpRequestMessage { Headers = { { "x-csrf-token", "Fetch" } } });
        // var csrfToken = csrfResponse.Headers.GetValues("x-csrf-token").First();
        //
        // // Create the purchase order
        // var poData = new {
        //     PurchaseOrderType = "NB",
        //     Supplier = vendorId,
        //     PurchasingOrganization = purchasingOrganization,
        //     PurchasingGroup = purchasingGroup,
        //     CompanyCode = companyCode,
        //     DocumentDate = documentDate.ToString("yyyy-MM-dd"),
        //     to_PurchaseOrderItem = items.Select(item => new {
        //         Material = item.MaterialId,
        //         OrderQuantity = item.Quantity.ToString(),
        //         NetPriceAmount = item.UnitPrice.ToString("F2"),
        //         Plant = item.Plant,
        //         ScheduleLine = new[] {
        //             new { DeliveryDate = item.DeliveryDate }
        //         }
        //     }).ToArray()
        // };
        //
        // var content = new StringContent(
        //     JsonSerializer.Serialize(poData), 
        //     Encoding.UTF8, 
        //     "application/json");
        //
        // sapClient.DefaultRequestHeaders.Add("x-csrf-token", csrfToken);
        // var response = await sapClient.PostAsync(
        //     "/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder", 
        //     content);
        //
        // var responseData = await response.Content.ReadAsStringAsync();
        // var result = JsonSerializer.Deserialize<SAPResponse>(responseData);
        // return result.d.PurchaseOrder;

        // Generate a mock SAP PO number (10 digits, starting with 45)
        var poNumber = $"45{DateTime.Now.Ticks % 100000000:D8}";

        logger.LogInformation(
            "Mock: Created PO {PONumber} for vendor {VendorId} with {ItemCount} items",
            poNumber, vendorId, items.Count);

        return poNumber;
    }

    /// <summary>
    /// Retrieves a purchase order from SAP S/4HANA.
    /// 
    /// Production Implementation:
    /// GET https://{sap-host}/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder('{poNumber}')?$expand=to_PurchaseOrderItem
    /// </summary>
    private async Task<object?> GetPurchaseOrderFromSAPAsync(string purchaseOrderNumber)
    {
        // Example implementation using HttpClient and OData API
        using (HttpClientHandler handler = new HttpClientHandler())
        {

            handler.ServerCertificateCustomValidationCallback =
                            (message, cert, chain, errors) => true;

            using var httpClient = new HttpClient(handler);
            httpClient.BaseAddress = new Uri("https://microsoftintegrationdemo.com:44301");

            // Add authentication header (Bearer token or Basic auth)
            //httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", await GetSAPTokenAsync());

            // Replace with your SAP username and password from configuration
            var username = configuration["SAP:Username"];
            var password = configuration["SAP:Password"];
            var credentials = Convert.ToBase64String(System.Text.Encoding.ASCII.GetBytes($"{username}:{password}"));
            httpClient.DefaultRequestHeaders.Add("Accept", "application/json");
            httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Basic", credentials);

            // Get CSRF token
            var csrfRequest = new HttpRequestMessage(HttpMethod.Get, "/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV/");
            csrfRequest.Headers.Add("x-csrf-token", "Fetch");
            var csrfResponse = await httpClient.SendAsync(csrfRequest);
            if (!csrfResponse.Headers.TryGetValues("x-csrf-token", out var csrfTokens))
                throw new Exception("Failed to retrieve CSRF token from SAP.");
            var csrfToken = csrfTokens.First();

            // Build OData URL for PO details
            var requestUrl = $"/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder('{purchaseOrderNumber}')?$expand=to_PurchaseOrderItem";

            var request = new HttpRequestMessage(HttpMethod.Get, requestUrl);
            request.Headers.Add("x-csrf-token", csrfToken);

            var response = await httpClient.SendAsync(request);
            if (!response.IsSuccessStatusCode)
            {
                var errorContent = await response.Content.ReadAsStringAsync();
                throw new Exception($"SAP API error: {response.StatusCode} - {errorContent}");
            }

            var responseData = await response.Content.ReadAsStringAsync();

            // You may want to define a POResponse class to deserialize the response
            // For now, return the raw JSON
            return JsonSerializer.Deserialize<object>(responseData);
        }
    }

    /// <summary>
    /// Retrieves an OAuth 2.0 access token from SAP S/4HANA.
    /// 
    /// This method implements the OAuth 2.0 Client Credentials flow for SAP authentication.
    /// 
    /// Production Configuration Required:
    /// 1. SAP OAuth 2.0 endpoint (e.g., https://{sap-host}/sap/bc/sec/oauth2/token)
    /// 2. Client ID and Client Secret from SAP Cloud Platform or SAP NetWeaver
    /// 3. Token scope (typically 'OAUTH2_CLIENT_CREDENTIALS')
    /// 
    /// SAP OAuth 2.0 Documentation:
    /// https://help.sap.com/docs/SAP_S4HANA_CLOUD/0f69f8fb28ac4bf48d2b57b9637e81fa/
    /// </summary>
    /// <returns>A valid OAuth 2.0 access token for SAP API calls</returns>
    private async Task<string> GetSAPTokenAsync()
    {
        try
        {
            logger.LogInformation("Retrieving SAP OAuth token for agent {AgentId}", agent.AgentId);

            // TODO: Replace these with actual configuration values from appsettings.json or Azure Key Vault
            // Example configuration structure:
            // {
            //   "SAP": {
            //     "TokenEndpoint": "https://your-sap-host.com/sap/bc/sec/oauth2/token",
            //     "ClientId": "your-client-id",
            //     "ClientSecret": "your-client-secret",
            //     "Scope": "OAUTH2_CLIENT_CREDENTIALS"
            //   }
            // }

            var tokenEndpoint = "https://microsoftintegrationdemo.com:44301/sap/bc/sec/oauth2/token";
            var clientId = "your-client-id";  // TODO: Move to configuration
            var clientSecret = "your-client-secret";  // TODO: Move to Azure Key Vault

            // Create HTTP client with SSL certificate validation bypass for development
            // WARNING: Remove this in production!
            var handler = new HttpClientHandler
            {
                ServerCertificateCustomValidationCallback = (message, cert, chain, errors) => true
            };

            using var httpClient = new HttpClient(handler);

            // Prepare OAuth 2.0 token request
            var tokenRequest = new Dictionary<string, string>
            {
                ["grant_type"] = "client_credentials",
                ["client_id"] = clientId,
                ["client_secret"] = clientSecret,
                ["scope"] = "OAUTH2_CLIENT_CREDENTIALS"  // SAP-specific scope
            };

            var requestContent = new FormUrlEncodedContent(tokenRequest);

            logger.LogDebug("Requesting OAuth token from SAP endpoint: {Endpoint}", tokenEndpoint);

            // Send token request
            var response = await httpClient.PostAsync(tokenEndpoint, requestContent);

            if (!response.IsSuccessStatusCode)
            {
                var errorContent = await response.Content.ReadAsStringAsync();
                logger.LogError(
                    "Failed to retrieve SAP OAuth token. Status: {StatusCode}, Error: {Error}",
                    response.StatusCode, errorContent);
                throw new Exception($"SAP OAuth token request failed: {response.StatusCode} - {errorContent}");
            }

            var responseContent = await response.Content.ReadAsStringAsync();
            var tokenResponse = JsonSerializer.Deserialize<SAPTokenResponse>(responseContent);

            if (tokenResponse == null || string.IsNullOrWhiteSpace(tokenResponse.AccessToken))
            {
                throw new Exception("SAP OAuth token response was null or empty");
            }

            logger.LogInformation(
                "Successfully retrieved SAP OAuth token. Expires in: {ExpiresIn} seconds",
                tokenResponse.ExpiresIn);

            return tokenResponse.AccessToken;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error retrieving SAP OAuth token for agent {AgentId}", agent.AgentId);
            throw;
        }
    }

    /// <summary>
    /// Alternative implementation using Basic Authentication instead of OAuth.
    /// Use this if your SAP system uses Basic Auth rather than OAuth 2.0.
    /// </summary>
    /// <param name="username">SAP username</param>
    /// <param name="password">SAP password</param>
    /// <returns>Base64-encoded credentials for Basic Auth header</returns>
    private string GetBasicAuthCredentials(string username, string password)
    {
        var credentials = Convert.ToBase64String(
            System.Text.Encoding.ASCII.GetBytes($"{username}:{password}"));

        logger.LogDebug("Generated Basic Auth credentials for user: {Username}", username);

        return credentials;
    }

    #endregion

    #region Helper Classes

    /// <summary>
    /// Represents a supplier option with pricing and delivery information.
    /// </summary>
    private class SupplierOption
    {
        public string Name { get; set; } = string.Empty;
        public decimal UnitPrice { get; set; }
        public int EtaDays { get; set; }
        public int OnTimePercentage { get; set; }
    }

    /// <summary>
    /// Represents a purchase order line item.
    /// </summary>
    private class PurchaseOrderItem
    {
        public string MaterialId { get; set; } = string.Empty;
        public decimal Quantity { get; set; }
        public decimal UnitPrice { get; set; }
        public string Plant { get; set; } = string.Empty;
        public string DeliveryDate { get; set; } = string.Empty;
    }

    /// <summary>
    /// Represents the OAuth 2.0 token response from SAP.
    /// </summary>
    private class SAPTokenResponse
    {
        [JsonPropertyName("access_token")]
        public string AccessToken { get; set; } = string.Empty;

        [JsonPropertyName("token_type")]
        public string TokenType { get; set; } = "Bearer";

        [JsonPropertyName("expires_in")]
        public int ExpiresIn { get; set; }

        [JsonPropertyName("scope")]
        public string Scope { get; set; } = string.Empty;
    }

    #endregion
}