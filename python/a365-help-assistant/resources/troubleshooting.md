# Microsoft Agent 365 - Troubleshooting Guide

## Common Issues and Solutions

### Authentication Issues

#### Error: "OpenAI API key or Azure credentials are required"

**Cause:** No valid API credentials found in environment variables.

**Solution:**
1. Create a `.env` file in your project root
2. Add one of the following configurations:

For OpenAI:
```
OPENAI_API_KEY=sk-your-openai-api-key
```

For Azure OpenAI:
```
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_KEY=your-azure-key
AZURE_OPENAI_DEPLOYMENT=gpt-4o-mini
```

#### Error: "Authentication failed" or "401 Unauthorized"

**Cause:** Invalid or expired credentials.

**Solutions:**
1. Verify your API key is valid and not expired
2. For Azure AD authentication, check:
   - CLIENT_ID is correct
   - TENANT_ID matches your Azure AD tenant
   - CLIENT_SECRET is valid and not expired
3. Ensure your Azure subscription is active

#### Error: "Token exchange failed"

**Cause:** Issues with agentic authentication flow.

**Solutions:**
1. Verify AUTH_HANDLER_NAME is set correctly (typically "AGENTIC")
2. Ensure the agent app has proper permissions in Azure AD
3. Check that the user has consented to the required permissions

### Connection Issues

#### Error: "Connection refused" or "Cannot connect to server"

**Cause:** Server not running or wrong port configuration.

**Solutions:**
1. Verify the server is running: `python start_with_generic_host.py`
2. Check if the port is already in use:
   ```bash
   netstat -an | findstr :3978
   ```
3. Try a different port by setting `PORT=3979` in your environment

#### Error: "MCP server connection failed"

**Cause:** MCP tool server is not accessible.

**Solutions:**
1. Verify ToolingManifest.json configuration
2. Ensure MCP servers are running and accessible
3. Check network connectivity to MCP server endpoints
4. Enable debug logging to see connection attempts

### Runtime Errors

#### Error: "Agent is not available"

**Cause:** Agent failed to initialize properly.

**Solutions:**
1. Check the startup logs for initialization errors
2. Verify all required dependencies are installed
3. Ensure environment variables are loaded correctly
4. Try running in development mode with more verbose logging:
   ```
   ENVIRONMENT=Development
   ```

#### Error: "Tool execution failed"

**Cause:** MCP tool encountered an error during execution.

**Solutions:**
1. Check tool-specific error messages in logs
2. Verify tool authentication is working
3. Enable SKIP_TOOLING_ON_ERRORS=true for development to bypass tool issues:
   ```
   ENVIRONMENT=Development
   SKIP_TOOLING_ON_ERRORS=true
   ```

#### Memory or Performance Issues

**Symptoms:** Slow responses, high memory usage, or crashes.

**Solutions:**
1. Monitor memory usage and increase container/VM resources if needed
2. Implement response streaming for long outputs
3. Use appropriate model settings (lower temperature, reasonable token limits)
4. Enable connection pooling for HTTP clients

### Observability Issues

#### Error: "Observability configuration failed"

**Cause:** Issues with Agent 365 observability setup.

**Solutions:**
1. Check token resolver is returning valid tokens
2. Verify service name and namespace are set correctly
3. Ensure observability packages are installed:
   ```bash
   pip install microsoft_agents_a365_observability_core
   ```

#### Traces not appearing in monitoring

**Cause:** Instrumentation not enabled or exporter not configured.

**Solutions:**
1. Verify OpenAIAgentsTraceInstrumentor is called
2. Check OBSERVABILITY_SERVICE_NAME is set
3. Ensure token resolver returns valid authentication tokens

### Deployment Issues

#### Container fails to start

**Possible Causes:**
- Missing environment variables
- Wrong Python version
- Missing dependencies

**Solutions:**
1. Check container logs for specific errors
2. Verify all required environment variables are set in Azure
3. Ensure Dockerfile uses Python 3.11+
4. Rebuild image with latest dependencies

#### Azure App Service issues

**Solutions:**
1. Enable application logging in Azure Portal
2. Check startup command is correct
3. Verify SCM deployment logs
4. Ensure all app settings are configured

## Debugging Tips

### Enable Debug Logging

Add to your `.env` file:
```
ENVIRONMENT=Development
LOG_LEVEL=DEBUG
```

### Check Agent Health

Access the health endpoint:
```
curl http://localhost:3978/api/health
```

Expected response:
```json
{
  "status": "ok",
  "agent_type": "A365HelpAssistant",
  "agent_initialized": true,
  "auth_mode": "anonymous"
}
```

### Common Log Messages

| Log Message | Meaning |
|-------------|---------|
| "✅ Agent initialized successfully" | Agent is ready to process messages |
| "🔐 Using auth handler: AGENTIC" | Production authentication is enabled |
| "🔓 No auth handler configured" | Running in anonymous/development mode |
| "⚠️ Observability configuration failed" | Telemetry not available |
| "❌ Error processing message" | Error during message handling |

## Getting Help

If you're still experiencing issues:

1. **Check the documentation:**
   - [Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
   - [Testing Guide](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing)

2. **Search existing issues:**
   - [GitHub Issues](https://github.com/microsoft/Agent365-python/issues)

3. **Create a new issue:**
   Include:
   - Error message and stack trace
   - Environment configuration (redact secrets)
   - Steps to reproduce
   - Python version and OS

4. **Contact Support:**
   - Email: support@microsoft.com
