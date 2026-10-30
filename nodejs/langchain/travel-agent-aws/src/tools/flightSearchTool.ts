// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { tool } from "@langchain/core/tools";
import { z } from "zod";

const AIRLINES = ["Delta Air Lines", "United Airlines", "Alaska Airlines", "American Airlines", "Southwest Airlines", "JetBlue"];

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export const flightSearchTool = tool(
  async ({ origin, destination, departureDate, returnDate }): Promise<string> => {
    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      const airline = AIRLINES[randomInt(0, AIRLINES.length - 1)];
      const code = airline.slice(0, 2).toUpperCase() + randomInt(100, 9999);
      const hour = randomInt(6, 21);
      const minute = randomInt(0, 59);
      const durationH = randomInt(2, 8);
      const durationM = randomInt(0, 59);
      const stops = randomInt(0, 2);
      const price = randomInt(150, 900);
      results.push(
        `  ${i + 1}. **${airline}** (${code})\n` +
        `     Depart: ${departureDate} at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}\n` +
        `     Duration: ${durationH}h ${durationM}m | ${stops === 0 ? "Nonstop" : `${stops} stop${stops > 1 ? "s" : ""}`}\n` +
        `     Price: $${price} round-trip`
      );
    }

    return `✈️ **Flights from ${origin} to ${destination}**\n` +
      `Departure: ${departureDate} | Return: ${returnDate}\n\n` +
      results.join("\n\n");
  },
  {
    name: "SearchFlights",
    description: "Search for flights between two cities on given dates. Returns 3 flight options.",
    schema: z.object({
      origin: z.string().describe("Departure city or airport code"),
      destination: z.string().describe("Arrival city or airport code"),
      departureDate: z.string().describe("Departure date (YYYY-MM-DD)"),
      returnDate: z.string().describe("Return date (YYYY-MM-DD)"),
    }),
  }
);
