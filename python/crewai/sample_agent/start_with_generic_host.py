# Copyright (c) Microsoft. All rights reserved.
#!/usr/bin/env python3
"""
Example: Direct usage of Generic Agent Host with CrewAI wrapper.
"""

import sys

try:
    from agent import CrewAIAgent
    from host_agent_server import create_and_run_host
except ImportError as e:
    print(f"Import error: {e}")
    print("Please ensure you're running from the correct directory")
    sys.exit(1)


def main():
    """Main entry point - start the generic host with CrewAIAgent."""
    try:
        print("Starting Generic Agent Host with CrewAIAgent...")
        print()
        create_and_run_host(CrewAIAgent)
    except Exception as e:
        print(f"Failed to start server: {e}")
        import traceback

        traceback.print_exc()
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
