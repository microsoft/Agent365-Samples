# Use Python 3.11 full Debian image
FROM python:3.11

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy project files
COPY pyproject.toml ./
COPY *.py ./
COPY .env* ./

# Install uv
RUN pip install --no-cache-dir uv

# Install dependencies
RUN uv pip install --system --pre -e .

EXPOSE 3978
ENV PORT=3978

CMD ["python", "start_with_generic_host.py"]
