# Amazon Bedrock sample agent (Python)

This sample shows how to build an agent using Amazon Bedrock (Claude) in Python with the Microsoft Agent 365 SDK. It demonstrates:

- **Streaming responses**: Real-time message delivery using Bedrock's streaming API
- **Observability**: End-to-end tracing and monitoring with Agent 365 observability
- **Notifications**: Email notification handling for agent applications
- **Multi-cloud architecture**: AWS Bedrock with Microsoft 365 Agents SDK

This sample uses the [Microsoft Agent 365 SDK for Python](https://github.com/microsoft/Agent365-python).

For comprehensive documentation on building agents with the Microsoft Agent 365 SDK, visit the [Microsoft Agent 365 developer documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Prerequisites

- Python 3.11 or higher
- An AWS account with Bedrock access
- Claude model access enabled in your AWS region
- Microsoft Agent 365 SDK packages

## Getting AWS credentials

Follow these steps to set up AWS access for Bedrock:

### 1. Create an IAM user

1. Sign in to the [AWS Management Console](https://console.aws.amazon.com/)
2. Go to **IAM** > **Users** > **Create user**
3. Enter a username (for example, `bedrock-agent-user`)
4. Select **Next** to set permissions

### 2. Attach Bedrock permissions

1. Choose **Attach policies directly**
2. Search for and select **AmazonBedrockFullAccess**
3. Select **Next**, then **Create user**

### 3. Generate access keys

1. Select the user you created
2. Go to **Security credentials** > **Access keys** > **Create access key**
3. Choose **Application running outside AWS**
4. Select **Create access key**
5. Copy your **Access key ID** and **Secret access key** (you won't see the secret key again)

### 4. Enable Claude model access

1. Go to **Amazon Bedrock** in the AWS Console
2. Select **Model access** in the left navigation
3. Select **Manage model access**
4. Enable **Claude 3 Sonnet** (or your preferred Claude model)
5. Select **Save changes**

> **Note**: Model access approval can take a few minutes.

## Configuration

1. Copy the environment template:

   ```bash
   cp .env.template .env
   ```

2. Fill in your AWS credentials:

   ```dotenv
   AWS_ACCESS_KEY_ID=your_access_key_id
   AWS_SECRET_ACCESS_KEY=your_secret_access_key
   AWS_REGION=us-east-1
   BEDROCK_MODEL_ID=anthropic.claude-3-sonnet-20240229-v1:0
   ```

3. Configure the Microsoft Entra ID app registration for agent authentication. Add your service connection settings to `.env`.

## Running the agent

To set up and test this agent, see the [Configure agent testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing?tabs=python) guide for complete instructions.

### Quick start

1. Install dependencies:

   ```bash
   pip install -e .
   ```

2. Start the agent:

   ```bash
   cd src
   python main.py
   ```

The server starts on `http://127.0.0.1:3978` by default.

## Project structure

```text
python/bedrock/sample-agent/
├── src/
│   ├── __init__.py        # Package initialization
│   ├── main.py            # Server entry point
│   ├── agent.py           # Agent class with message handlers
│   ├── client.py          # Bedrock client with observability
│   └── token_cache.py     # Token caching for observability
├── .env.template          # Environment variable template
├── pyproject.toml         # Python project configuration
├── README.md              # This file
└── ToolingManifest.json   # MCP tooling configuration
```

## Troubleshooting

### "Access denied" errors from Bedrock

- Verify your AWS credentials are correct in `.env`
- Check that Claude model access is enabled in your AWS region
- Ensure your IAM user has the `AmazonBedrockFullAccess` policy

### "Model not found" errors

- Confirm the model ID in `BEDROCK_MODEL_ID` matches an enabled model
- Check [available Bedrock models](https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html) for your region

### Server startup errors

- Verify all required environment variables are set
- Check that Python 3.11+ is installed
- Ensure all dependencies are installed with `pip install -e .`

## Support

For issues, questions, or feedback:

- **Issues**: File issues in the [GitHub Issues](https://github.com/microsoft/Agent365-python/issues) section
- **Documentation**: See the [Microsoft Agent 365 developer documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Security**: For security issues, see [SECURITY.md](../../../SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot automatically determines whether you need to provide a CLA and decorates the PR appropriately (for example, status check, comment). Follow the instructions provided by the bot. You only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information, see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Additional resources

- [Microsoft Agent 365 SDK - Python repository](https://github.com/microsoft/Agent365-python)
- [Microsoft 365 Agents SDK - Python repository](https://github.com/Microsoft/Agents-for-python)
- [Amazon Bedrock documentation](https://docs.aws.amazon.com/bedrock/)
- [Anthropic Claude documentation](https://docs.anthropic.com/)

## Trademarks

Microsoft, Windows, Microsoft Azure, and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at <http://go.microsoft.com/fwlink/?LinkID=254653>.

Amazon Web Services, AWS, and Amazon Bedrock are trademarks of Amazon.com, Inc. or its affiliates.

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License. See the [LICENSE](../../../LICENSE.md) file for details.
