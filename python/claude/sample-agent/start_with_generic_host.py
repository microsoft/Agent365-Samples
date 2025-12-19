# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

#!/usr/bin/env python3
"""
Example: Direct usage of Claude Agent with Generic Host
This script starts the M365 Agents SDK hosting server with ClaudeAgent.
"""

import sys

try:
    from agent import ClaudeAgent
    from host_agent_server import create_and_run_host
except ImportError as e:
     print(f"Import error: {e}")
     print("Please ensure you're running from the correct directory")
     sys.exit(1)


def main():
    """Main entry point - start the generic host with ClaudeAgent"""
    try:     
        print("✅ Starting Generic Agent Host with ClaudeAgent...")
        print()

        # Use the convenience function to start hosting
        create_and_run_host(ClaudeAgent)

    except Exception as e:
        print(f"❌ Failed to start server: {e}")
        import traceback
        traceback.print_exc()
        return 1

    return 0


if __name__ == "__main__":
    exit(main())
