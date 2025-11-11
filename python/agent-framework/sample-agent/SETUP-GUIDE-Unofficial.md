# Quick Setup Guide

> **NOTE: This file should be removed before Ignite.**

Get the A365 Python SDK sample running in 7 simple steps.

## Setup Steps

### 1. Verify Python installation

First, ensure you have Python 3.11 or higher installed:

```powershell
# Check if Python is installed
python --version
```

If Python is not found:
- Download and install Python 3.11+ from <https://python.org>
- Make sure to check "Add Python to PATH" during installation
- Restart VS Code and try again

**✅ Success Check**: You should see Python 3.11.x or higher

### 2. Verify prerequisites

Ensure you have the required Microsoft Agent365 packages:

```powershell
# Navigate to the agent-framework directory (parent of sample-agent)
cd ..

# Check if dist folder exists with required wheel files
ls dist
```

If the dist folder doesn't exist or is empty, you have two options:

#### Option A: Download from GitHub Actions (Recommended)
1. Create the dist folder: `mkdir dist`
2. Download the required .whl files:
   - Visit: https://github.com/microsoft/Agent365-python (get the packages from main)
   - Click on **Artifacts** → **python-3.11**
   - Download the zip file and extract the wheel files into the dist folder:
     - `microsoft_agents_a365_tooling-*.whl`
     - `microsoft_agents_a365_tooling_extensions_agentframework-*.whl`
     - `microsoft_agents_a365_observability_core-*.whl`
     - `microsoft_agents_a365_observability_extensions_agent_framework-*.whl`
     - `microsoft_agents_a365_runtime-*.whl`
     - `microsoft_agents_a365_notifications-*.whl`

#### Option B: Install from PyPI
If packages are available on PyPI, you can install them directly (skip to step 6 and modify the installation command).

**✅ Success Check**: The dist folder should contain the Microsoft Agent365 wheel files.

```powershell
# Return to sample-agent directory for next steps
cd sample-agent
```

### 3. Set up environment configuration

Open PowerShell in VS Code (Terminal → New Terminal) and navigate to the sample-agent directory:

```powershell
# Navigate to the sample-agent directory (where this README is located)
# Make sure you're in the sample-agent folder
cd sample-agent

# Copy the environment template
copy .env.template .env
```

### 4. Update environment variables

Open the newly created `.env` file and update the following values:

```env
AZURE_OPENAI_API_KEY=<your_azure_openai_api_key>
AZURE_OPENAI_ENDPOINT=<your_azure_openai_endpoint>
AZURE_OPENAI_DEPLOYMENT=<your_azure_openai_deployment>
AZURE_OPENAI_API_VERSION="2024-02-01"
```

### 5. Install uv

uv is a fast Python package manager. Open PowerShell in VS Code (Terminal → New Terminal) and run:

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

### 6. Set up the project

Continue in the same terminal (make sure you're still in the sample-agent directory):

```powershell
# Verify you're in the right directory - you should see pyproject.toml
ls pyproject.toml

# Create virtual environment with pip included
uv venv .venv

# Activate the virtual environment
.\.venv\Scripts\Activate.ps1

# Verify setup - you should see (.venv) in your prompt
python --version
```

**✅ Success Check**: Your terminal shows `(.venv)` at the beginning and you can see `pyproject.toml` in the directory

### 7. Install dependencies

Install all dependencies from the local wheel files and PyPI:

```powershell
uv pip install -e . --find-links ../dist --pre
```

**Important**: You may see some warning messages about dependencies. **This is normal and expected** - the agent will work correctly.

**✅ Success Check**: "Installed X packages" message appears

### 8. Start the agent

```powershell
python start_with_generic_host.py
```

**✅ Success Check**: You should see:
```
🚀 Starting server on localhost:3978
🎯 Ready for testing!
======== Running on http://localhost:3978 ========
```

## Testing with Microsoft 365 Agents Playground

After starting the server, you can test it using the Microsoft 365 Agents Playground.

In a separate terminal, start the playground:

```powershell
agentsplayground
```

You should see the Microsoft 365 Agents Playground running locally and ready to interact with your agent.

## Troubleshooting

### Common Issues

- **"python is not recognized"** → Install Python 3.11+ from python.org and check "Add Python to PATH"

- **"uv not found"** → Restart your terminal and try step 4 again

- **"No module named 'dotenv'"** → Try: `uv pip install python-dotenv`

- **"No module named..."** → Make sure you see `(.venv)` in your prompt and that the installation command in step 6 completed successfully. Most missing dependencies should already be included in requirements.txt, but if you still get errors, you can install them individually:
  ```powershell
  # For any additional missing modules:
  uv pip install <module-name>
  ```

- **Dependency conflict warnings** → These are expected! Continue with the next step - the agent will work fine

- **"No solution found when resolving dependencies"** → Make sure you're using the installation process in step 6 and that the dist folder exists with wheel files

- **Agent won't start** → Check you're in the sample-agent directory and that all installation steps completed successfully

## Done!

Your agent is now running and ready for testing. Configuration values will be provided during the bug bash session.
