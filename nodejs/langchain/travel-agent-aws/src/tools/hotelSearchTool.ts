// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { tool } from "@langchain/core/tools";
import { z } from "zod";

const HOTELS = [
  { brand: "Hilton", tier: "Upscale" },
  { brand: "Marriott", tier: "Upscale" },
  { brand: "Hyatt Regency", tier: "Upscale" },
  { brand: "Four Seasons", tier: "Luxury" },
  { brand: "Westin", tier: "Upper Upscale" },
  { brand: "Holiday Inn", tier: "Midscale" },
];

const AMENITIES = [
  "Free Wi-Fi", "Pool", "Spa", "Fitness Center", "Restaurant",
  "Business Center", "Complimentary Breakfast", "Rooftop Bar",
  "Concierge", "Pet-Friendly",
];

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom<T>(arr: T[], count: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

export const hotelSearchTool = tool(
  async ({ destination, checkIn, checkOut }): Promise<string> => {
    const picked = pickRandom(HOTELS, 3);
    const hotels = picked.map((h, i) => {
      const price = randomInt(120, 700);
      const rating = (3 + Math.random() * 2).toFixed(1);
      const amenities = pickRandom(AMENITIES, randomInt(3, 5)).join(", ");
      return `  ${i + 1}. **${h.brand} ${destination}** (${h.tier})\n` +
        `     Rating: ⭐ ${rating}/5.0\n` +
        `     Price: $${price}/night\n` +
        `     Amenities: ${amenities}`;
    });

    return `🏨 **Hotels in ${destination}**\n` +
      `Check-in: ${checkIn} | Check-out: ${checkOut}\n\n` +
      hotels.join("\n\n");
  },
  {
    name: "SearchHotels",
    description: "Search for hotels at a destination for given dates. Returns 3 hotel options.",
    schema: z.object({
      destination: z.string().describe("City or area to search for hotels"),
      checkIn: z.string().describe("Check-in date (YYYY-MM-DD)"),
      checkOut: z.string().describe("Check-out date (YYYY-MM-DD)"),
    }),
  }
);
