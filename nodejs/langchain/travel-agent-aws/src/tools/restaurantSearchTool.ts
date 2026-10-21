// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { tool } from "@langchain/core/tools";
import { z } from "zod";

const RESTAURANTS: Record<string, Array<{ name: string; cuisine: string; priceRange: string }>> = {
  breakfast: [
    { name: "The Morning Table", cuisine: "American Brunch", priceRange: "$$" },
    { name: "Sunrise Café", cuisine: "Café & Bakery", priceRange: "$" },
    { name: "Golden Griddle", cuisine: "Classic Breakfast", priceRange: "$$" },
    { name: "Egg & Co.", cuisine: "Farm-to-Table", priceRange: "$$$" },
  ],
  lunch: [
    { name: "The Urban Fork", cuisine: "New American", priceRange: "$$$" },
    { name: "Sakura Sushi", cuisine: "Japanese", priceRange: "$$" },
    { name: "Bella Trattoria", cuisine: "Italian", priceRange: "$$" },
    { name: "Taco Loco", cuisine: "Mexican Street Food", priceRange: "$" },
  ],
  dinner: [
    { name: "Le Petit Bistro", cuisine: "French", priceRange: "$$$$" },
    { name: "Steakhouse 55", cuisine: "Steakhouse", priceRange: "$$$$" },
    { name: "Jade Palace", cuisine: "Chinese Fine Dining", priceRange: "$$$" },
    { name: "Ristorante Milano", cuisine: "Italian", priceRange: "$$$" },
  ],
};

function pickRandom<T>(arr: T[], count: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function randomRating(): string {
  return (3.5 + Math.random() * 1.5).toFixed(1);
}

export const restaurantSearchTool = tool(
  async ({ destination, mealType }): Promise<string> => {
    const meal = mealType.toLowerCase() as keyof typeof RESTAURANTS;
    const pool = RESTAURANTS[meal] ?? RESTAURANTS.lunch;
    const picks = pickRandom(pool, 3);

    const list = picks.map((r, i) =>
      `  ${i + 1}. **${r.name}** — ${r.cuisine}\n` +
      `     Rating: ⭐ ${randomRating()}/5.0 | Price: ${r.priceRange}`
    );

    const emoji = meal === "breakfast" ? "🥐" : meal === "lunch" ? "🍽️" : "🌙";
    return `${emoji} **${mealType.charAt(0).toUpperCase() + mealType.slice(1)} Restaurants in ${destination}**\n\n` +
      list.join("\n\n");
  },
  {
    name: "SearchRestaurants",
    description: "Search for restaurants at a destination for a specific meal type (breakfast, lunch, or dinner). Returns 3 restaurant picks.",
    schema: z.object({
      destination: z.string().describe("City or area to search for restaurants"),
      mealType: z.enum(["breakfast", "lunch", "dinner"]).describe("Meal type: breakfast, lunch, or dinner"),
    }),
  }
);
