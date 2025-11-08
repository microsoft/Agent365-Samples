# Quick Setup Guide

Get the A365 Python SDK sample running in 7 simple steps.

## Setup Steps

### 1. Verify prerequisites
First, ensure you have the required Microsoft Agent365 packages:

```powershell
# Navigate to the agent-framework directory (parent of sample-agent)
cd ..

# Check if dist folder exists with required wheel files
ls dist
```

**If the dist folder doesn't exist or is empty:**
- Create the `dist` folder: `mkdir dist`
- Download or copy the required `.whl` files to the `dist` folder:
  - `microsoft_agents_a365_tooling-*.whl`
  - `microsoft_agents_a365_tooling_extensions_agentframework-*.whl`
  - `microsoft_agents_a365_observability_core-*.whl`
  - `microsoft_agents_a365_observability_extensions_agent_framework-*.whl`
  - `microsoft_agents_a365_runtime-*.whl`
  - `microsoft_agents_a365_notifications-*.whl`

**✅ Success Check**: The `dist` folder should contain the Microsoft Agent365 wheel files.

```powershell
# Return to sample-agent directory for next steps
cd sample-agent
```

### 2. Set up environment configuration
Open PowerShell **in VS Code** (Terminal → New Terminal) and navigate to the sample-agent directory:

```powershell
# Navigate to the sample-agent directory (where this README is located)
# Make sure you're in the sample-agent folder
cd sample-agent

# Copy the environment template
copy .env.template .env
```

### 3. Update environment variables
Open the newly created `.env` file and update the following values:

```
AZURE_OPENAI_API_KEY=<your_azure_openai_api_key>
AZURE_OPENAI_ENDPOINT=<your_azure_openai_endpoint>
AZURE_OPENAI_DEPLOYMENT=<your_azure_openai_deployment>
AZURE_OPENAI_API_VERSION="2024-02-01"
```

### 4. Install uv
uv is a fast Python package manager. Open PowerShell **in VS Code** (Terminal → New Terminal) and run:

```powershell
# Install uv
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# Add uv to PATH for this session (only if not already there)
if ($env:PATH -notlike "*$env:USERPROFILE\.local\bin*") {
    $env:PATH += ";$env:USERPROFILE\.local\bin"
}

# Test that uv works
uv --version
```

### 5. Set up the project
Continue in the same terminal (make sure you're still in the sample-agent directory):

```powershell
# Verify you're in the right directory - you should see pyproject.toml
ls pyproject.toml

# First, check if Python is installed
python --version
```

**If Python is not found:**
- Download and install Python 3.11+ from https://python.org
- Make sure to check "Add Python to PATH" during installation
- Restart VS Code and try again

**If Python is found, continue:**
```powershell
# Create virtual environment with pip included
uv venv .venv --seed

# Activate the virtual environment
.\.venv\Scripts\Activate.ps1

# Verify setup - you should see (.venv) in your prompt
python --version
```

**✅ Success Check**: Your terminal shows `(.venv)` at the beginning and you can see pyproject.toml in the directory

### 6. Install dependencies

Due to version constraints in the wheel files, we need to install in steps:

```powershell
# Install the main package without dependencies
uv pip install -e . --find-links ../dist --pre --no-deps

# Install the remaining dependencies
uv pip install agent-framework-azure-ai microsoft-agents-hosting-aiohttp microsoft-agents-hosting-core microsoft-agents-authentication-msal microsoft-agents-activity azure-identity python-dotenv aiohttp "uvicorn[standard]>=0.20.0" "fastapi>=0.100.0" "httpx>=0.24.0" "pydantic>=2.0.0" "typing-extensions>=4.0.0" wrapt --find-links ../dist --pre

# Install the local Microsoft Agent365 packages
uv pip install microsoft-agents-a365-tooling microsoft-agents-a365-tooling-extensions-agentframework microsoft-agents-a365-observability-core microsoft-agents-a365-observability-extensions-agent-framework microsoft-agents-a365-runtime microsoft-agents-a365-notifications --find-links ../dist --pre --no-deps
```

**Important**: You may see some warning messages about dependencies. **This is normal and expected** - the agent will work correctly.

**✅ Success Check**: 
- First command: "Installed 1 package" 
- Second command: "Installed X packages" (multiple packages from PyPI)
- Third command: "Installed X packages" (Microsoft Agent365 packages)

### 7. Start the agent
```powershell
python start_with_generic_host.py
```

**✅ Success Check**: You should see:
```
🚀 Starting server on localhost:3978
🎯 Ready for testing!
======== Running on http://localhost:3978 ========
```

## Troubleshooting

**"python is not recognized"** → Install Python 3.11+ from python.org and check "Add Python to PATH"

**"uv not found"** → Restart your terminal and try step 1 again

**"No module named 'dotenv'"** → Try: `uv pip install python-dotenv`

**"No module named..."** → Make sure you see `(.venv)` in your prompt and that all three installation commands in step 6 completed successfully. If you get specific missing module errors, install them individually:
```powershell
# For common missing modules, try:
uv pip install wrapt opentelemetry-instrumentation opentelemetry-instrumentation-aiohttp-client opentelemetry-instrumentation-fastapi
# or if that fails, try:
uv pip install wrapt opentelemetry-api opentelemetry-sdk opentelemetry-instrumentation-aiohttp
```

**Dependency conflict warnings** → These are expected! Continue with the next step - the agent will work fine

**"No solution found when resolving dependencies"** → Make sure you're using the three-step installation process in step 6 and that the dist folder exists with wheel files

**Agent won't start** → Check you're in the sample-agent directory and that all installation steps completed successfully

## Done! 
Your agent is now running and ready for testing. Configuration values will be provided during the bug bash session.