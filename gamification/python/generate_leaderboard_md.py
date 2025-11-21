# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Generate leaderboard markdown for display in README.
"""

from database import GamificationDatabase
from datetime import datetime


def generate_leaderboard_markdown():
    """Generate markdown leaderboard for README."""
    db = GamificationDatabase()
    
    # Get top 10 contributors
    leaderboard = db.get_leaderboard(limit=10)
    
    # Get stats
    conn = db.get_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT COUNT(*) as count FROM contributors")
    total_contributors = cursor.fetchone()['count']
    
    cursor.execute("SELECT SUM(total_points) as total FROM contributors")
    total_points = cursor.fetchone()['total'] or 0
    
    # Generate markdown
    markdown = f"""# 🏆 Gamification Leaderboard

*Last updated: {datetime.now().strftime('%B %d, %Y at %H:%M UTC')}*

## 📊 Statistics

- **Total Contributors:** {total_contributors}
- **Total Points Awarded:** {total_points:,}
- **Active Contributors:** {len([c for c in leaderboard if c['current_streak'] > 0])}

## 🌟 Top Contributors

| Rank | Contributor | Points | Streak | Badges |
|------|-------------|--------|--------|--------|
"""
    
    # Medal emojis for top 3
    medals = {1: "🥇", 2: "🥈", 3: "🥉"}
    
    for idx, entry in enumerate(leaderboard, 1):
        medal = medals.get(idx, f"**{idx}**")
        username = entry['github_username']
        points = f"{entry['total_points']:,}"
        streak = f"🔥 {entry['current_streak']}" if entry['current_streak'] > 0 else "-"
        badges = f"🎖️ {entry.get('badge_count', 0)}"
        
        markdown += f"| {medal} | [{username}](https://github.com/{username}) | {points} | {streak} | {badges} |\n"
    
    markdown += f"""
## 🎮 How to Participate

Earn points by contributing to Agent365-Samples! Check out our [Gamification Guide](gamification/README.md) for details on:

- 📝 Points system for different contributions
- 🎯 Multipliers and bonuses
- 🎖️ Badge achievements
- 📈 Tracking your progress

[View Full Leaderboard & Badges →](gamification/README.md)

---

*Powered by Agent365-Samples Gamification System*
"""
    
    # Write to file (in gamification directory) with UTF-8 encoding
    with open('../LEADERBOARD.md', 'w', encoding='utf-8') as f:
        f.write(markdown)
    
    print("✅ Leaderboard markdown generated at gamification/LEADERBOARD.md")
    db.close()


if __name__ == "__main__":
    generate_leaderboard_markdown()
