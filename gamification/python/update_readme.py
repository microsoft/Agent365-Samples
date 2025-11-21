# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Updates the main repository README.md with the latest leaderboard data.
Inserts the leaderboard between special markers so it displays directly in GitHub.
"""

import sqlite3
import os
import re
from pathlib import Path


def get_leaderboard_html():
    """Generate HTML table for the leaderboard that renders in GitHub."""
    db_path = Path(__file__).parent / "gamification.db"
    
    if not db_path.exists():
        return "<!-- No leaderboard data available yet -->"
    
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Get top 10 contributors
    cursor.execute("""
        SELECT 
            c.github_username,
            c.total_points,
            c.current_streak,
            COUNT(con.id) as contribution_count
        FROM contributors c
        LEFT JOIN contributions con ON c.id = con.contributor_id
        GROUP BY c.github_username
        ORDER BY c.total_points DESC
        LIMIT 10
    """)
    
    rows = cursor.fetchall()
    conn.close()
    
    if not rows:
        return "<!-- No contributors yet -->"
    
    # Build HTML table
    html = ['<table>']
    html.append('  <thead>')
    html.append('    <tr>')
    html.append('      <th align="center">🏆 Rank</th>')
    html.append('      <th align="left">Contributor</th>')
    html.append('      <th align="center">⭐ Points</th>')
    html.append('      <th align="center">🔥 Streak</th>')
    html.append('      <th align="center">📊 Contributions</th>')
    html.append('    </tr>')
    html.append('  </thead>')
    html.append('  <tbody>')
    
    medals = ['🥇', '🥈', '🥉']
    for idx, (username, points, streak, contributions) in enumerate(rows, 1):
        medal = medals[idx - 1] if idx <= 3 else f'{idx}.'
        html.append('    <tr>')
        html.append(f'      <td align="center"><strong>{medal}</strong></td>')
        html.append(f'      <td><a href="https://github.com/{username}">@{username}</a></td>')
        html.append(f'      <td align="center"><strong>{points:,}</strong></td>')
        html.append(f'      <td align="center">{streak} days</td>')
        html.append(f'      <td align="center">{contributions}</td>')
        html.append('    </tr>')
    
    html.append('  </tbody>')
    html.append('</table>')
    
    return '\n'.join(html)


def get_stats_badges():
    """Generate quick stats badges."""
    db_path = Path(__file__).parent / "gamification.db"
    
    if not db_path.exists():
        return ""
    
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Get total stats
    cursor.execute("SELECT COUNT(*), SUM(total_points) FROM contributors")
    result = cursor.fetchone()
    
    # Get total contributions
    cursor.execute("SELECT COUNT(*) FROM contributions")
    total_contributions = cursor.fetchone()[0]
    
    conn.close()
    
    if not result:
        return ""
    
    total_contributors, total_points = result
    total_contributors = total_contributors or 0
    total_points = total_points or 0
    total_contributions = total_contributions or 0
    
    badges = f"""
![Contributors](https://img.shields.io/badge/Contributors-{total_contributors}-blue)
![Total Points](https://img.shields.io/badge/Total%20Points-{total_points:,}-green)
![Contributions](https://img.shields.io/badge/Contributions-{total_contributions}-orange)
"""
    return badges.strip()


def update_readme_with_gamification():
    """Insert gamification section into main README."""
    
    # Find the main README
    repo_root = Path(__file__).parent.parent.parent
    readme_path = repo_root / "README.md"
    
    if not readme_path.exists():
        print(f"❌ Main README not found at {readme_path}")
        return
    
    # Read current README
    content = readme_path.read_text(encoding='utf-8')
    
    # Generate leaderboard sections
    stats = get_stats_badges()
    leaderboard = get_leaderboard_html()
    
    # Create the leaderboard section
    leaderboard_section = f"""<!-- GAMIFICATION_START -->
## 🏆 Contributor Leaderboard

{stats}

### Top Contributors

{leaderboard}

**[View full leaderboard and badges →](gamification/LEADERBOARD.md)**

*Leaderboard updated every 6 hours by GitHub Actions. [Learn about our gamification system →](gamification/README.md)*
<!-- GAMIFICATION_END -->"""
    
    # Define markers
    start_marker = "<!-- GAMIFICATION_START -->"
    end_marker = "<!-- GAMIFICATION_END -->"
    
    # Check if markers exist
    if start_marker in content and end_marker in content:
        # Replace existing section
        pattern = f"{re.escape(start_marker)}.*?{re.escape(end_marker)}"
        updated_readme = re.sub(
            pattern, 
            leaderboard_section, 
            content, 
            flags=re.DOTALL
        )
    else:
        # Add section near the top (after first heading)
        lines = content.split('\n')
        insert_pos = 0
        
        # Find first heading
        for i, line in enumerate(lines):
            if line.strip().startswith('#'):
                insert_pos = i + 1
                break
        
        # Insert leaderboard section
        lines.insert(insert_pos, '')
        lines.insert(insert_pos + 1, leaderboard_section)
        lines.insert(insert_pos + 2, '')
        updated_readme = '\n'.join(lines)
    
    # Write updated README
    readme_path.write_text(updated_readme, encoding='utf-8')
    print(f"✅ Updated {readme_path}")
    print(f"📊 Leaderboard now visible in GitHub repo!")


if __name__ == "__main__":
    update_readme_with_gamification()
