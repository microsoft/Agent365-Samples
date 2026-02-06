# Microsoft Agent 365 - Deployment Guide

## Overview

This guide covers deployment options for Microsoft Agent 365 agents to various Azure services.

## Deployment Options

### 1. Azure App Service

Azure App Service provides a fully managed platform for hosting web applications and APIs.

#### Prerequisites
- Azure subscription
- Azure CLI installed
- Docker installed (for container deployment)

#### Steps

1. **Create an App Service:**
   ```bash
   az webapp create --resource-group myResourceGroup \
     --plan myAppServicePlan \
     --name my-agent-app \
     --runtime "PYTHON:3.11"
   ```

2. **Configure environment variables:**
   ```bash
   az webapp config appsettings set --resource-group myResourceGroup \
     --name my-agent-app \
     --settings OPENAI_API_KEY=your_key
   ```

3. **Deploy your code:**
   ```bash
   az webapp deployment source config-local-git --resource-group myResourceGroup \
     --name my-agent-app
   git push azure main
   ```

### 2. Azure Container Apps

Azure Container Apps is ideal for microservices and containerized agents.

#### Dockerfile

```dockerfile
FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
EXPOSE 3978

CMD ["python", "start_with_generic_host.py"]
```

#### Deployment

```bash
az containerapp create \
  --name my-agent \
  --resource-group myResourceGroup \
  --environment myEnvironment \
  --image myregistry.azurecr.io/my-agent:latest \
  --target-port 3978 \
  --ingress external
```

### 3. Azure Kubernetes Service (AKS)

For enterprise-scale deployments with full orchestration capabilities.

#### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: a365-agent
spec:
  replicas: 3
  selector:
    matchLabels:
      app: a365-agent
  template:
    metadata:
      labels:
        app: a365-agent
    spec:
      containers:
      - name: agent
        image: myregistry.azurecr.io/a365-agent:latest
        ports:
        - containerPort: 3978
        env:
        - name: OPENAI_API_KEY
          valueFrom:
            secretKeyRef:
              name: agent-secrets
              key: openai-key
```

## Security Best Practices

1. **Store secrets in Azure Key Vault**
2. **Use Managed Identity for Azure service authentication**
3. **Enable HTTPS/TLS for all endpoints**
4. **Implement proper CORS policies**
5. **Use private endpoints where possible**

## Scaling Considerations

- Use horizontal pod autoscaling for Kubernetes deployments
- Configure App Service scaling rules based on CPU/memory
- Implement caching for frequently accessed data
- Use Azure Redis Cache for session management

## Monitoring

### Application Insights

Enable Application Insights for comprehensive monitoring:

```python
from microsoft_agents_a365.observability.core.config import configure

configure(
    service_name="my-agent",
    service_namespace="production",
    token_resolver=token_resolver,
)
```

### Health Checks

All agents expose a health endpoint at `/api/health` that returns:
- Agent status
- Initialization state
- Authentication mode

## Troubleshooting Deployment

| Issue | Solution |
|-------|----------|
| Container fails to start | Check environment variables are set correctly |
| Authentication errors | Verify CLIENT_ID and TENANT_ID configuration |
| Connection timeouts | Check network security group rules |
| Memory issues | Increase container memory limits |

## Related Documentation

- [Azure App Service Documentation](https://docs.microsoft.com/azure/app-service/)
- [Azure Container Apps Documentation](https://docs.microsoft.com/azure/container-apps/)
- [Azure Kubernetes Service Documentation](https://docs.microsoft.com/azure/aks/)
