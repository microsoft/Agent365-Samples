using Azure.Data.Tables;
using Azure.Identity;
using Azure.Security.KeyVault.Certificates;
using ProcurementA365Agent.AgentLogic;
using ProcurementA365Agent.AgentLogic.AuthCache;
using ProcurementA365Agent.AgentLogic.SemanticKernel;
using ProcurementA365Agent.Mcp;
using ProcurementA365Agent.Models;
using ProcurementA365Agent.NotificationService;
using ProcurementA365Agent.Services;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Hosting.AspNetCore;
using Microsoft.Agents.Storage;
using Microsoft.Agents.A365.Observability.Runtime;
using Microsoft.Agents.A365.Observability.Extensions.SemanticKernel;
using Microsoft.Agents.A365.Tooling.Services;
using Microsoft.Agents.A365.Tooling.Extensions.SemanticKernel.Services;
using Microsoft.Agents.A365.Observability.Runtime.Tracing.Exporters;
using System.Security.Cryptography.X509Certificates;
using Microsoft.Agents.Storage.Transcript;

var builder = WebApplication.CreateBuilder(args);

// Add Azure Key Vault as configuration provider when running in production (not locally)
var keyVaultName = builder.Configuration["KeyVaultName"];
if (!string.IsNullOrEmpty(keyVaultName))
{
    var keyVaultUri = $"https://{keyVaultName}.vault.azure.net/";

    // Use DefaultAzureCredential which will use Managed Service Identity in production
    builder.Configuration.AddAzureKeyVault(
        new Uri(keyVaultUri),
        new DefaultAzureCredential());

    Console.WriteLine($"Azure Key Vault configured: {keyVaultUri}");
}
else
{
    Console.WriteLine("KeyVaultName not configured. Key Vault integration skipped.");
}

// ===================================
// Certificate Management for Authentication
// ===================================
var certThumbprint = builder.Configuration["Connections:ServiceConnection:Settings:CertThumbprint"];
var certName = builder.Configuration["KeyVaultCertificateName"];
X509Certificate2? authCertificate = null;

Console.WriteLine("=== CERTIFICATE MANAGEMENT ===");
Console.WriteLine($"Platform: {(OperatingSystem.IsWindows() ? "Windows" : "Linux/Azure")}");
Console.WriteLine($"Auth Type: {builder.Configuration["Connections:ServiceConnection:Settings:AuthType"]}");

var authType = builder.Configuration["Connections:ServiceConnection:Settings:AuthType"];

// Only handle certificates if AuthType is Certificate
if (authType?.Equals("Certificate", StringComparison.OrdinalIgnoreCase) == true)
{
    Console.WriteLine($"Certificate Thumbprint: {certThumbprint}");
    Console.WriteLine($"Key Vault Name: {keyVaultName}");
    Console.WriteLine($"Certificate Name: {certName}");

    if (!string.IsNullOrEmpty(keyVaultName) && !string.IsNullOrEmpty(certName))
    {
        try
        {
            Console.WriteLine($"\nDownloading certificate '{certName}' from Key Vault...");
            
            var kvUri = new Uri($"https://{keyVaultName}.vault.azure.net/");
            var credential = new DefaultAzureCredential();
            var certClient = new CertificateClient(kvUri, credential);
            
            // Download certificate with private key
            var downloadedCert = await certClient.DownloadCertificateAsync(certName);
            authCertificate = downloadedCert.Value;
            
            Console.WriteLine($"? Downloaded certificate from Key Vault:");
            Console.WriteLine($"  Subject: {authCertificate.Subject}");
            Console.WriteLine($"  Thumbprint: {authCertificate.Thumbprint}");
            Console.WriteLine($"  Has Private Key: {authCertificate.HasPrivateKey}");
            
            // Only try to add to certificate store on Windows
            if (OperatingSystem.IsWindows())
            {
                Console.WriteLine("\n[Windows] Importing certificate to Certificate Store...");
                try
                {
                    using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser);
                    store.Open(OpenFlags.ReadWrite);
                    
                    var existing = store.Certificates.Find(X509FindType.FindByThumbprint, authCertificate.Thumbprint, false);
                    if (existing.Count == 0)
                    {
                        store.Add(authCertificate);
                        Console.WriteLine($"? Certificate added to CurrentUser\\My store");
                    }
                    else
                    {
                        Console.WriteLine($"? Certificate already exists in store");
                    }
                    
                    store.Close();
                }
                catch (Exception storeEx)
                {
                    Console.WriteLine($"? Warning: Could not add to certificate store: {storeEx.Message}");
                }
            }
            else
            {
                Console.WriteLine("\n[Linux/Azure] Certificate downloaded but NOT added to store (not supported on Linux)");
                Console.WriteLine("? SDK connections requiring certificate store will fail.");
                Console.WriteLine("?? Recommendation: Use AuthType=ManagedIdentity in appsettings.json for Azure deployments");
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"? ERROR: Failed to download certificate from Key Vault: {ex.Message}");
            if (ex.InnerException != null)
            {
                Console.WriteLine($"   Inner Exception: {ex.InnerException.Message}");
            }
            throw;
        }
    }
    else
    {
        Console.WriteLine("? Certificate configuration incomplete:");
        Console.WriteLine($"  KeyVaultName: {(string.IsNullOrEmpty(keyVaultName) ? "MISSING" : "OK")}");
        Console.WriteLine($"  CertificateName: {(string.IsNullOrEmpty(certName) ? "MISSING" : "OK")}");
    }
}
else if (authType?.Equals("ManagedIdentity", StringComparison.OrdinalIgnoreCase) == true)
{
    Console.WriteLine("? Using Managed Identity authentication (no certificate needed)");
    Console.WriteLine("  This is the recommended approach for Azure deployments");
}
else
{
    Console.WriteLine($"? Unknown or missing AuthType: {authType}");
}

// Store the certificate in DI for AgentTokenHelper (if needed for custom auth)
if (authCertificate != null)
{
    builder.Services.AddSingleton(authCertificate);
    Console.WriteLine("\n? Certificate registered in DI for AgentTokenHelper");
}

Console.WriteLine("=== END CERTIFICATE MANAGEMENT ===\n");

// Add controllers support
builder.Services.AddControllers();

// ===================================
// These are needed for Agent SDK
// ===================================
builder.Services.AddHttpClient();
builder.Services.AddSingleton<IStorage, MemoryStorage>();
builder.AddAgentApplicationOptions();

builder.AddAgent<A365AgentApplication>();
// Uncomment this so you can get logs of activities.
if (builder.Configuration["RecordTranscript"] == "true")
{
    builder.Services.AddSingleton<Microsoft.Agents.Builder.IMiddleware[]>([new TranscriptLoggerMiddleware(new FileTranscriptLogger())]);
}
// Register Agent Logic Service Factory as singleton
builder.Services.AddSingleton<AgentLogicServiceFactory>();

// Register Background Worker Service
builder.Services
    .AddHostedService<BackgroundNotificationService>()
    .AddScoped<HiringService>();

// Register Azure Table Storage service with DefaultAzureCredential
var storageEndpoint = builder.Configuration["AzureStorageEndpoint"];
var storageConnectionString = builder.Configuration.GetConnectionString("AzureStorageConnectionString")
    ?? builder.Configuration["AzureStorageConnectionString"];

if (!string.IsNullOrEmpty(storageConnectionString) && storageConnectionString != "UseDevelopmentStorage=true")
{
    // Use connection string for non-development scenarios
    builder.Services.AddSingleton(new TableServiceClient(storageConnectionString));
}
else if (storageConnectionString == "UseDevelopmentStorage=true")
{
    // Use local emulator
    builder.Services.AddSingleton(new TableServiceClient(storageConnectionString));
}
else if (!string.IsNullOrEmpty(storageEndpoint))
{
    // Use DefaultAzureCredential with the specified storage account
    builder.Services.AddSingleton(new TableServiceClient(new Uri(storageEndpoint), new DefaultAzureCredential()));
}
else
{
    throw new InvalidOperationException("AzureStorageEndpoint or AzureStorageConnectionString must be configured.");   
}

builder.Services
    .AddSingleton<IAgentMetadataRepository, StorageTableService>()
    .AddSingleton<IAgentBlueprintRepository, StorageTableService>();

builder.Services
    .AddSingleton<SemanticKernelAgentLogicServiceFactory>()
    .AddSingleton<McpToolDiscovery>();
builder.Services.AddScoped<IAgentMessagingService, AgentMessagingService>();
builder.Services.AddScoped<GraphService>();
builder.Services.AddScoped<DataverseService>();

// Register Tooling services
builder.Services.AddSingleton<IMcpToolRegistrationService, McpToolRegistrationService>();
builder.Services.AddSingleton<IMcpToolServerConfigurationService, McpToolServerConfigurationService>();

// Register auth helper
builder.Services.AddSingleton<AgentTokenHelper>();
builder.Services.AddSingleton<IAgentTokenCache, AgentTokenCache>();
// Register Webhook Service
builder.Services.AddScoped<IActivitySenderService, ActivitySenderService>();

// Register OpenAPI for external agents
builder.Services.AddOpenApi();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();
builder.Services.AddLogging(logging =>
{
    logging.AddConsole();
    logging.AddDebug();
});

#region Setup A365


AppContext.SetSwitch("Azure.Experimental.TraceGenAIMessageContent", true);
AppContext.SetSwitch("System.Net.Http.SocketsHttpHandler.Http2UnencryptedSupport", true);



builder.Services.AddSingleton(sp =>
{
    var cache = sp.GetRequiredService<IAgentTokenCache>();
    return new Agent365ExporterOptions
    {
        ClusterCategory = "prod",
        TokenResolver = (agentId, tenantId) => Task.FromResult(cache.GetObservabilityToken(agentId, tenantId)) // fast cached lookup
    };
});

builder.AddA365Tracing(config =>
{
    config.WithSemanticKernel();
});


#endregion

var app = builder.Build();

// ===================================
// These are needed for Agent SDK
// ===================================
app.UseRouting();
// Enable buffering globally - this allows request body to be read multiple times
app.Use(next => context =>
{
    context.Request.EnableBuffering();
    return next(context);
});


app.MapPost("/api/messages", async (HttpRequest request, HttpResponse response, IAgentHttpAdapter adapter, IAgent agent, CancellationToken cancellationToken) =>
{
    // Comment out this line to disable request logging
    // await request.LogRequestAsync();
    Console.WriteLine("Received request at /api/messages");

    await adapter.ProcessAsync(request, response, agent, cancellationToken);
});

app.MapGet("/", () => {
    Console.WriteLine("Tracing Status is: " + Environment.GetEnvironmentVariable("EnableAgent365Exporter"));
    Console.WriteLine("Tracing Status is A365 flag: " + Environment.GetEnvironmentVariable("EnableA365Tracing"));

    return "Meet your Procurement Agent!";
    });

// Initialize Azure Table Storage
using (var scope = app.Services.CreateScope())
{
    var storageService = scope.ServiceProvider.GetService<IAgentMetadataRepository>();
    if (storageService is StorageTableService tableService)
    {
        await tableService.InitializeAsync();
    }
}

if (!app.Environment.IsDevelopment())
{
    app.UseHsts();
}

app.Use(next => context =>
{
    context.Request.EnableBuffering();
    return next(context);
});

// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseHttpsRedirection();

// Map controllers
app.MapControllers();

app.Run();
