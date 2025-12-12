# Application Insights Integration

This guide explains how to enable and configure Application Insights telemetry for the Agent Framework sample agent.

## Overview

Application Insights integration is **optional** and disabled by default. When enabled, it provides:

- **Distributed Tracing**: End-to-end request tracing across services
- **Performance Monitoring**: Track response times, dependencies, and bottlenecks
- **Exception Tracking**: Automatic capture and reporting of errors
- **Custom Metrics**: Track agent-specific metrics and KPIs
- **Live Metrics**: Real-time monitoring of your agent's performance
- **Dependency Tracking**: Monitor calls to Azure OpenAI, databases, and other services

## Prerequisites

1. **Azure Subscription**: You need an active Azure subscription
2. **Application Insights Resource**: Create an Application Insights resource in Azure Portal
3. **Connection String**: Obtain the connection string from your Application Insights resource

## Setup Instructions

### 1. Create Application Insights Resource

#### Option A: Azure Portal
1. Go to [Azure Portal](https://portal.azure.com)
2. Click **Create a resource** → Search for **Application Insights**
3. Fill in the details:
   - **Resource Group**: Use existing or create new (e.g., `agent365-samples-rg`)
   - **Name**: e.g., `agent-framework-python-insights`
   - **Region**: Same as your other resources (e.g., `East US`)
   - **Resource Mode**: Workspace-based (recommended)
4. Click **Review + Create** → **Create**

#### Option B: Azure CLI
```bash
# Create Application Insights resource
az monitor app-insights component create \
  --app agent-framework-python-insights \
  --location eastus \
  --resource-group agent365-samples-rg \
  --workspace <your-log-analytics-workspace-id>

# Get the connection string
az monitor app-insights component show \
  --app agent-framework-python-insights \
  --resource-group agent365-samples-rg \
  --query connectionString \
  --output tsv
```

### 2. Get Connection String

1. Navigate to your Application Insights resource in Azure Portal
2. Go to **Overview** section
3. Copy the **Connection String** (it looks like: `InstrumentationKey=...;IngestionEndpoint=...`)

### 3. Configure Environment Variables

#### Local Development (.env file)
```bash
# Enable Application Insights
ENABLE_APPLICATION_INSIGHTS=true

# Your Application Insights connection string
APPLICATIONINSIGHTS_CONNECTION_STRING=InstrumentationKey=12345678-abcd-1234-abcd-123456789012;IngestionEndpoint=https://eastus-1.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus.livediagnostics.monitor.azure.com/
```

#### Azure Container Apps Deployment

Add these secrets to your GitHub repository:

1. Go to your GitHub repository → **Settings** → **Secrets and variables** → **Actions**
2. Add the following secrets:
   - `ENABLE_APPLICATION_INSIGHTS`: `true`
   - `APPLICATIONINSIGHTS_CONNECTION_STRING`: Your connection string from above

The GitHub Actions workflow will automatically configure these environment variables during deployment.

### 4. Install Dependencies

The required packages are already in `pyproject.toml`:
```toml
"opencensus-ext-azure>=1.1.13",
"azure-monitor-opentelemetry>=1.2.0"
```

If you need to install manually:
```bash
uv pip install azure-monitor-opentelemetry opencensus-ext-azure
```

## Usage

Once configured, Application Insights will automatically:

1. **Capture all traces** from your agent's operations
2. **Track dependencies** like Azure OpenAI API calls
3. **Log exceptions** with full stack traces
4. **Monitor performance** of agent responses
5. **Collect custom metrics** from the agent framework

### Verify It's Working

1. **Check Logs**: Look for this message on startup:
   ```
   ✅ Application Insights configured successfully
   📊 Telemetry will be sent to: InstrumentationKey=12345678...
   ```

2. **Azure Portal**:
   - Navigate to your Application Insights resource
   - Go to **Live Metrics** to see real-time data
   - Check **Transaction search** for request traces
   - View **Application map** to see dependencies

3. **Query Telemetry**:
   ```kusto
   // View all traces
   traces
   | where timestamp > ago(1h)
   | order by timestamp desc
   
   // View exceptions
   exceptions
   | where timestamp > ago(1h)
   | order by timestamp desc
   
   // View dependencies (e.g., Azure OpenAI calls)
   dependencies
   | where timestamp > ago(1h)
   | order by timestamp desc
   ```

## Disabling Application Insights

To disable Application Insights:

### Local Development
Set in your `.env` file:
```bash
ENABLE_APPLICATION_INSIGHTS=false
```

Or simply remove/comment out the environment variables.

### Azure Container Apps
Remove or set to `false` in GitHub Secrets:
- `ENABLE_APPLICATION_INSIGHTS`: `false`

## Troubleshooting

### Application Insights not sending data

**Check 1**: Verify connection string is correct
```python
# In your logs, you should see:
# ✅ Application Insights configured successfully
```

**Check 2**: Ensure the SDK is installed
```bash
uv pip list | grep azure-monitor
```

**Check 3**: Check for warnings in logs
```
⚠️ Application Insights enabled but APPLICATIONINSIGHTS_CONNECTION_STRING not set
```

### Import errors

If you see:
```
Import "azure.monitor.opentelemetry" could not be resolved
```

Install the package:
```bash
uv pip install azure-monitor-opentelemetry
```

### No data in Azure Portal

- **Wait 2-5 minutes**: There's a delay before telemetry appears
- **Check Sampling**: High-volume apps may be sampled down
- **Verify Network**: Ensure the app can reach Azure endpoints
- **Check Logs**: Look for Application Insights errors in agent logs

### Performance Impact

Application Insights is designed for production use with minimal overhead:
- **Typical latency**: < 10ms per request
- **Sampling**: Automatically reduces data in high-volume scenarios
- **Async**: Telemetry is sent asynchronously without blocking requests

## Advanced Configuration

### Custom Metrics and Events

You can add custom tracking in your agent code:

```python
from opentelemetry import trace

# Get the current tracer
tracer = trace.get_tracer(__name__)

# Create custom spans
with tracer.start_as_current_span("custom_operation") as span:
    span.set_attribute("user_query", query)
    span.set_attribute("agent_response_length", len(response))
    # Your code here
```

### Configure Sampling

To reduce costs in high-volume scenarios:

```python
from azure.monitor.opentelemetry import configure_azure_monitor

configure_azure_monitor(
    connection_string=connection_string,
    enable_live_metrics=True,
    sampling_ratio=0.1  # Sample 10% of requests
)
```

### Filter Sensitive Data

The agent already respects the `ENABLE_SENSITIVE_DATA` environment variable. To further customize:

```python
from opentelemetry.sdk.trace.export import SpanExportResult, SpanExporter

class FilteringSpanExporter(SpanExporter):
    def export(self, spans):
        for span in spans:
            # Remove sensitive attributes
            if "api_key" in span.attributes:
                span.attributes.pop("api_key")
        return SpanExportResult.SUCCESS
```

## Cost Considerations

Application Insights pricing is based on data ingestion:
- **First 5GB/month**: Free
- **Additional data**: ~$2.30 per GB (varies by region)
- **Data retention**: 90 days included, extended retention available

**Tips to reduce costs:**
1. Use sampling for high-volume applications
2. Filter out verbose logs
3. Set up data retention policies
4. Use log-based metrics instead of custom metrics

## Resources

- [Application Insights Overview](https://learn.microsoft.com/azure/azure-monitor/app/app-insights-overview)
- [OpenTelemetry Python SDK](https://learn.microsoft.com/azure/azure-monitor/app/opentelemetry-enable?tabs=python)
- [Azure Monitor Pricing](https://azure.microsoft.com/pricing/details/monitor/)
- [Query Telemetry with Kusto](https://learn.microsoft.com/azure/azure-monitor/logs/log-query-overview)

## Support

For issues with Application Insights integration:
- **SDK Issues**: [OpenTelemetry Python GitHub](https://github.com/open-telemetry/opentelemetry-python)
- **Azure Issues**: [Azure Monitor GitHub](https://github.com/Azure/azure-sdk-for-python/tree/main/sdk/monitor)
- **Agent Issues**: [Agent365-Samples GitHub Issues](https://github.com/microsoft/Agent365-Samples/issues)
