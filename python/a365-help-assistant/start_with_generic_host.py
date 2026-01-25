# Copyright (c) Microsoft. All rights reserved.

# !/usr/bin/env python3
"""
A365 Help Assistant - Start with Generic Host

This script starts the A365 Help Assistant using the generic agent host.
"""

import sys

try:
    from agent import A365HelpAssistant
    from host_agent_server import create_and_run_host
except ImportError as e:
    print(f"Import error: {e}")
    print("Please ensure you're running from the correct directory and all dependencies are installed")
    sys.exit(1)


def main():
    """Main entry point - start the generic host with A365HelpAssistant"""
    try:
        print("Starting A365 Help Assistant...")
        print()

        # Use the convenience function to start hosting
        create_and_run_host(A365HelpAssistant)

    except Exception as e:
        print(f"❌ Failed to start server: {e}")
        import traceback

        traceback.print_exc()
        return 1

    return 0


if __name__ == "__main__":
    exit(main())
