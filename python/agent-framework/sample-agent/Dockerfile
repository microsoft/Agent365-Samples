# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

# Python Agent Framework - Container Deployment
# Related to: https://github.com/microsoft/Agent365-Samples/pull/187
FROM python:3.12-slim

WORKDIR /app

# Suppress apt-get warnings in Docker
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies (gcc needed for some Python packages)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Upgrade pip
RUN pip install --no-cache-dir --upgrade pip

# Copy dependency metadata first for better layer caching
COPY pyproject.toml .

# Install Python dependencies from pyproject.toml
RUN pip install --no-cache-dir .

# Copy application code
COPY . .

# Create non-root user for security
RUN useradd --create-home --shell /bin/bash agentuser \
    && chown -R agentuser:agentuser /app
USER agentuser

# Expose port
EXPOSE 3978

# Set environment variables
ENV PORT=3978
ENV PYTHONUNBUFFERED=1

# Health check using PORT env var
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:${PORT}/api/health || exit 1

# Run the agent
CMD ["python", "start_with_generic_host.py"]
