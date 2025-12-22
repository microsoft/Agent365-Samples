# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
from crewai.tools import BaseTool
from typing import Type
from pydantic import BaseModel, Field
from crewai_tools import TavilySearchTool


class WeatherToolInput(BaseModel):
    """Input schema for WeatherTool."""
    location: str = Field(
        ..., 
        description=(
            "The city and state/country to check weather for. "
            "Can be any location format like 'London', 'San Francisco, CA', 'New York', etc."
        )
    )


class WeatherTool(BaseTool):
    name: str = "weather_checker"
    description: str = (
        "Search the web for current weather conditions for a specific location including temperature, "
        "precipitation, wind speed, humidity, and weather description. "
        "Accepts any location format like city names (e.g., 'London'), city with state (e.g., 'San Francisco, CA'), "
        "or any other location format. Use this to check weather before making driving decisions."
    )
    args_schema: Type[BaseModel] = WeatherToolInput

    def _run(self, location: str) -> str:
        """Search the web for current weather information for the given location.
        
        Uses web search to find current weather conditions including:
        - Temperature (current and feels like)
        - Weather conditions (rain, snow, clear, etc.)
        - Precipitation
        - Wind speed and direction
        - Humidity
        - Visibility
        """
        try:
            # Initialize TavilySearchTool for web searches
            search_tool = TavilySearchTool(
                search_depth="advanced",
                max_results=5,
                include_answer=True
            )
            
            # Construct search query for weather information
            search_query = f"current weather {location} temperature precipitation wind humidity visibility"
            
            # Perform web search
            search_results = search_tool._run(query=search_query)
            
            # Format the weather report from search results
            weather_report = f"""Current Weather Information for {location}:

{search_results}

Note: This information was retrieved from web search results. For the most accurate and up-to-date weather data, consider checking official weather services."""
            
            return weather_report
            
        except Exception as e:
            return f"Error searching for weather information: {str(e)}. Please try again or check the location name."
