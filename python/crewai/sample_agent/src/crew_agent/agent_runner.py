#!/usr/bin/env python
"""
Agent Runner - External trigger interface for running the crew.

This module provides a simple interface to run the crew with a given location/prompt.
It can be used:
- As a standalone script: python agent_runner.py "London"
- As a module: from crew_agent.agent_runner import run_crew
- Via environment variable: LOCATION="London" python agent_runner.py
"""

import os
import sys
import warnings
from datetime import datetime
from typing import Optional, Dict, Any
from pathlib import Path

# Load environment variables from .env file
from dotenv import load_dotenv

# Load .env file from project root (two levels up from this file)
env_path = Path(__file__).parent.parent.parent / '.env'
load_dotenv(dotenv_path=env_path)

from crew_agent.crew import CrewAgent

warnings.filterwarnings("ignore", category=SyntaxWarning, module="pysbd")


# Default prompt/location - can be overridden via parameter or environment variable
prompt: str = os.getenv("LOCATION", "London")


def run_crew(
    location: Optional[str] = None,
    return_result: bool = False,
    verbose: bool = True,
    mcps: Optional[list] = None,
) -> Optional[Any]:
    """
    Run the crew with the given location.
    
    Args:
        location: The location to check weather for. If None, uses the 'prompt' variable or environment variable.
        return_result: If True, returns the crew result. If False, just executes.
        verbose: Whether to print execution details.
    
    Returns:
        The crew result if return_result=True, otherwise None.
    
    Example:
        >>> result = run_crew(location="San Francisco, CA", return_result=True)
        >>> run_crew(location="London")  # Just executes, doesn't return
    """
    # Determine the location to use
    location_to_use = location or prompt
    
    if not location_to_use:
        raise ValueError(
            "Location is required. Provide it as parameter, set LOCATION env var, "
            "or set the 'prompt' variable in agent_runner.py"
        )
    
    # Prepare inputs for the crew
    inputs: Dict[str, str] = {
        'location': location_to_use,
        'current_year': str(datetime.now().year)
    }
    
    if verbose:
        print(f"🚀 Running crew for location: {location_to_use}")
        print(f"📅 Current year: {inputs['current_year']}")
        print("-" * 50)
    
    try:
        crew = CrewAgent(mcps=mcps).crew()
        result = crew.kickoff(inputs=inputs)
        
        if verbose:
            print("-" * 50)
            print("✅ Crew execution completed!")
        
        if return_result:
            return result
        
    except Exception as e:
        error_msg = f"❌ An error occurred while running the crew: {e}"
        if verbose:
            print(error_msg)
        raise Exception(error_msg) from e


def main():
    """
    Main entry point for command-line usage.
    
    Usage:
        python agent_runner.py                    # Uses default prompt/env var
        python agent_runner.py "London"           # Uses provided location
        python agent_runner.py "San Francisco, CA" # Uses provided location with state
    """
    # Get location from command line argument if provided
    location = None
    if len(sys.argv) > 1:
        location = sys.argv[1]
    
    # Run the crew
    run_crew(location=location, return_result=False, verbose=True)


if __name__ == "__main__":
    main()

