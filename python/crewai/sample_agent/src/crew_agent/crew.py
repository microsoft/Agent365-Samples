# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
from crewai import Agent, Crew, Process, Task
from crewai.project import CrewBase, agent, crew, task
from crewai.agents.agent_builder.base_agent import BaseAgent
from typing import List, Optional
# If you want to run a snippet of code before or after the crew starts,
# you can use the @before_kickoff and @after_kickoff decorators
# https://docs.crewai.com/concepts/crews#example-crew-class-with-decorators

@CrewBase
class CrewAgent():
    """CrewAgent crew"""

    agents: List[BaseAgent]
    tasks: List[Task]

    def __init__(self, mcps: Optional[list] = None):
        """
        Initialize CrewAgent with optional MCP tools.
        
        Args:
            mcps: List of observable MCP tool wrappers (CrewAI BaseTool instances)
                  These are tools with ExecuteToolScope observability, not raw MCP configs.
        """
        self.mcp_tools = mcps or []

    # Learn more about YAML configuration files here:
    # Agents: https://docs.crewai.com/concepts/agents#yaml-configuration-recommended
    # Tasks: https://docs.crewai.com/concepts/tasks#yaml-configuration-recommended
    
    # If you would like to add tools to your agents, you can learn more about it here:
    # https://docs.crewai.com/concepts/agents#agent-tools
    @agent
    def weather_checker(self) -> Agent:
        from crew_agent.tools.custom_tool import WeatherTool
        # Combine built-in tools with observable MCP tools
        all_tools = [WeatherTool()] + self.mcp_tools
        return Agent(
            config=self.agents_config['weather_checker'], # type: ignore[index]
            tools=all_tools,
            verbose=True,
        )

    @agent
    def driving_safety_advisor(self) -> Agent:
        # Pass observable MCP tools with ExecuteToolScope tracing
        return Agent(
            config=self.agents_config['driving_safety_advisor'], # type: ignore[index]
            tools=self.mcp_tools,
            verbose=True,
        )

    # To learn more about structured task outputs,
    # task dependencies, and task callbacks, check out the documentation:
    # https://docs.crewai.com/concepts/tasks#overview-of-a-task
    @task
    def weather_check_task(self) -> Task:
        return Task(
            config=self.tasks_config['weather_check_task'], # type: ignore[index]
        )

    @task
    def driving_safety_task(self) -> Task:
        return Task(
            config=self.tasks_config['driving_safety_task'], # type: ignore[index]
            output_file='driving_safety_report.md'
        )

    @crew
    def crew(self) -> Crew:
        """Creates the CrewAgent crew"""
        # To learn how to add knowledge sources to your crew, check out the documentation:
        # https://docs.crewai.com/concepts/knowledge#what-is-knowledge

        return Crew(
            agents=self.agents, # Automatically created by the @agent decorator
            tasks=self.tasks, # Automatically created by the @task decorator
            process=Process.sequential,
            verbose=True,
            # process=Process.hierarchical, # In case you wanna use that instead https://docs.crewai.com/how-to/Hierarchical/
        )
