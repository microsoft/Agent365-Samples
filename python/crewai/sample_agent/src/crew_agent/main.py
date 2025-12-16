# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
#!/usr/bin/env python


"""
Legacy local-run helper for CrewAI agents.

NOTE:
    This file is *not* the primary entry point for running the sample.

    The official Agent365 sample entry point is:

        start_with_generic_host.py

This file is retained only for developers who want to run CrewAI directly
without Agent365 hosting. It should not be referenced as the main sample entry
point in documentation or reviews.
"""

import sys
import warnings
from pathlib import Path
from datetime import datetime

# Load environment variables from .env file
from dotenv import load_dotenv

# Load .env file from project root
env_path = Path(__file__).parent.parent.parent / '.env'
load_dotenv(dotenv_path=env_path)

from crew_agent.crew import CrewAgent

warnings.filterwarnings("ignore", category=SyntaxWarning, module="pysbd")

# This main file is intended to be a way for you to run your
# crew locally, so refrain from adding unnecessary logic into this file.
# Replace with inputs you want to test with, it will automatically
# interpolate any tasks and agents information

# ---------------------------------------------------------------------------
# Local-only functions for developers
# ---------------------------------------------------------------------------


def run():
    """
    Run the crew.
    """
    inputs = {
        'location': 'London',
        'current_year': str(datetime.now().year)
    }

    try:
        CrewAgent().crew().kickoff(inputs=inputs)
    except Exception as e:
        raise Exception(f"An error occurred while running the crew: {e}") from e


def train():
    """
    Train the crew for a given number of iterations.
    """
    inputs = {
        "location": "London",
        'current_year': str(datetime.now().year)
    }
    try:
        CrewAgent().crew().train(n_iterations=int(sys.argv[1]), filename=sys.argv[2], inputs=inputs)

    except Exception as e:
        raise Exception(f"An error occurred while training the crew: {e}") from e

def replay():
    """
    Replay the crew execution from a specific task.
    """
    try:
        CrewAgent().crew().replay(task_id=sys.argv[1])

    except Exception as e:
        raise Exception(f"An error occurred while replaying the crew: {e}") from e

def test():
    """
    Test the crew execution and returns the results.
    """
    inputs = {
        "location": "London",
        "current_year": str(datetime.now().year)
    }

    try:
        CrewAgent().crew().test(n_iterations=int(sys.argv[1]), eval_llm=sys.argv[2], inputs=inputs)

    except Exception as e:
        raise Exception(f"An error occurred while testing the crew: {e}") from e

def run_with_trigger():
    """
    Run the crew with trigger payload.
    """
    import json

    if len(sys.argv) < 2:
        raise Exception("No trigger payload provided. Please provide JSON payload as argument.")

    try:
        trigger_payload = json.loads(sys.argv[1])
    except json.JSONDecodeError:
        raise Exception("Invalid JSON payload provided as argument")

    inputs = {
        "crewai_trigger_payload": trigger_payload,
        "location": "London",
        "current_year": ""
    }

    try:
        result = CrewAgent().crew().kickoff(inputs=inputs)
        return result
    except Exception as e:
        raise Exception(f"An error occurred while running the crew with trigger: {e}") from e
    

# ---------------------------------------------------------------------------
# No "__main__" CLI — this file is no longer an entry point
# ---------------------------------------------------------------------------

# Intentionally removed:
#
#     if __name__ == "__main__":
#         run()
#
## The sample must be started using:
#     start_with_generic_host.py
#

