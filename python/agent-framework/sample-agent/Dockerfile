# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

# Python Agent Framework - Container Deployment
FROM python:3.12-slim

WORKDIR /app

# Suppress apt-get warnings in Docker
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies (gcc needed for some Python packages)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Upgrade pip
RUN pip install --no-cache-dir --upgrade pip

# Copy application code
COPY . .

# Install Python dependencies from pyproject.toml
RUN pip install --no-cache-dir --root-user-action=ignore .

# Expose port
EXPOSE 3978

# Set environment variables
ENV PORT=3978
ENV PYTHONUNBUFFERED=1

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3978/api/health')" || exit 1

# Run the agent
CMD ["python", "start_with_generic_host.py"]
