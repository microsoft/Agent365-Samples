# Copyright (c) Microsoft. All rights reserved.

# !/usr/bin/env python3
"""
Example: Direct usage of Generic Agent Host with OpenAIAgentWithMCP
This script demonstrates direct usage without complex imports.
"""

import sys

try:
    from agent import OpenAIAgentWithMCP
    from host_agent_server import create_and_run_host
except ImportError as e:
    print(f"Import error: {e}")
    print("Please ensure you're running from the correct directory")
    sys.exit(1)


def main():
    """Main entry point - start the generic host with OpenAIAgentWithMCP"""
    try:
        print("Starting Generic Agent Host with OpenAIAgentWithMCP...")
        print()

        # Use the convenience function to start hosting
        create_and_run_host(OpenAIAgentWithMCP)

    except Exception as e:
        print(f"❌ Failed to start server: {e}")
        import traceback

        traceback.print_exc()
        return 1

    return 0


if __name__ == "__main__":
    exit(main())
