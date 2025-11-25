# Copyright (c) Microsoft. All rights reserved.

import json
import os
import sys
import argparse
import yaml
from datetime import datetime, timezone

LB_JSON = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'leaderboard.json')
OUT_MD = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'LEADERBOARD.md')
CONFIG_FILE = os.path.join(os.path.dirname(__file__), 'config_points.yml')

def parse_args():
    parser = argparse.ArgumentParser(
        description="Update LEADERBOARD.md from leaderboard.json and set the 'top' contributor for the README badge."
    )
    parser.add_argument("--limit", type=int, default=0,
                        help="Show only the top N contributors in LEADERBOARD.md (0 = show all).")
    parser.add_argument("--no-badge", action="store_true",
                        help="Do not write the 'top' key back into leaderboard.json.")
    parser.add_argument("--create-if-missing", action="store_true", default=True,
                        help="Create an empty leaderboard if none exists (default: True).")
    return parser.parse_args()

def create_empty_leaderboard():
    """
    Create an empty leaderboard.json file with a 'top' field.
    """
    empty_leaderboard = {
        "top": "None",
        "_comment": "This file tracks contributor points. Run assign_points.py to populate."
    }
    try:
        with open(LB_JSON, 'w', encoding='utf-8') as f:
            json.dump(empty_leaderboard, f, indent=2, ensure_ascii=False)
        print(f"Created empty leaderboard at: {LB_JSON}", file=sys.stderr)
        return empty_leaderboard
    except Exception as e:
        print(f"ERROR: Failed to create leaderboard.json: {e}", file=sys.stderr)
        sys.exit(1)

def load_leaderboard(create_if_missing=True):
    """
    Load leaderboard.json with improved error handling.
    
    Args:
        create_if_missing: If True, creates an empty leaderboard when missing
        
    Returns:
        dict: Leaderboard data or empty dict on unrecoverable error
    """
    if not os.path.exists(LB_JSON):
        if create_if_missing:
            print(f"WARNING: No leaderboard.json found at {LB_JSON}", file=sys.stderr)
            print("Creating empty leaderboard. Run assign_points.py to populate it.", file=sys.stderr)
            return create_empty_leaderboard()
        else:
            print(f"ERROR: No leaderboard.json found at {LB_JSON}", file=sys.stderr)
            print("Run assign_points.py first to create the leaderboard.", file=sys.stderr)
            sys.exit(1)

    try:
        with open(LB_JSON, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        print(f"ERROR: leaderboard.json contains invalid JSON: {e}", file=sys.stderr)
        print(f"File location: {LB_JSON}", file=sys.stderr)
        print("Fix the JSON syntax or delete the file to recreate it.", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: Failed to read leaderboard.json: {e}", file=sys.stderr)
        sys.exit(1)

    if not isinstance(data, dict):
        print(f"ERROR: leaderboard.json must be a JSON object (dict), got {type(data).__name__}", file=sys.stderr)
        print(f"File location: {LB_JSON}", file=sys.stderr)
        print("Expected format: {\"username\": points, ...}", file=sys.stderr)
        sys.exit(1)

    return data

def load_badge_config():
    """
    Load badge thresholds from config_points.yml.
    Returns default thresholds if config is missing or invalid.
    """
    default_badges = {
        'bronze_contributor': 10,
        'silver_contributor': 25,
        'gold_contributor': 50,
        'platinum_legend': 100
    }
    
    if not os.path.exists(CONFIG_FILE):
        print(f"WARNING: Config file not found, using default badge thresholds", file=sys.stderr)
        return default_badges
    
    try:
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            config = yaml.safe_load(f)
            return config.get('badges', default_badges)
    except Exception as e:
        print(f"WARNING: Failed to load badge config, using defaults: {e}", file=sys.stderr)
        return default_badges

def get_badge_for_points(points, badge_config):
    """
    Determine the highest badge earned for given points.
    Returns tuple of (badge_name, badge_emoji).
    """
    if points >= badge_config.get('platinum_legend', 100):
        return ('Platinum Legend', '💎')
    elif points >= badge_config.get('gold_contributor', 50):
        return ('Gold Contributor', '🥇')
    elif points >= badge_config.get('silver_contributor', 25):
        return ('Silver Contributor', '🥈')
    elif points >= badge_config.get('bronze_contributor', 10):
        return ('Bronze Contributor', '🥉')
    else:
        return ('', '')

def normalize_scores(leaderboard):
    """
    Ensure points are integers and filter out non-user keys other than 'top'.
    Returns a list of (user, points) tuples suitable for sorting.
    """
    items = []
    for user, points in leaderboard.items():
        # Skip metadata fields
        if user in ('top', '_comment'):
            continue
        try:
            # Convert numeric strings/floats to int safely
            points_int = int(float(points))
        except (ValueError, TypeError):
            # If points cannot be parsed, skip this user
            print(f"WARNING: Skipping '{user}' due to non-numeric points: {points}", file=sys.stderr)
            continue
        items.append((user, points_int))
    return items

def sort_contributors(items):
    """
    Sort by points descending, then by user name ascending for stable tie ordering.
    """
    return sorted(items, key=lambda x: (-x[1], x[0].lower()))

def write_badge_top(leaderboard, items, no_badge=False):
    """
    Write 'top' contributor back to leaderboard.json unless disabled.
    """
    if no_badge:
        return

    top_user = items[0][0] if items else "None"
    leaderboard['top'] = top_user

    try:
        with open(LB_JSON, 'w', encoding='utf-8') as f:
            json.dump(leaderboard, f, indent=2, ensure_ascii=False)
        print(f"Updated top contributor: {top_user}")
    except Exception as e:
        print(f"WARNING: Failed to write updated leaderboard.json: {e}", file=sys.stderr)
        # Non-fatal: continue to write the MD even if we couldn't update the badge key

def render_markdown(items, limit=0):
    """
    Build the markdown leaderboard table with badges, optional row limit, and a 'Last updated' footer.
    """
    badge_config = load_badge_config()
    
    if limit > 0:
        items = items[:limit]

    lines = []
    lines.append("# Contributor Leaderboard\n\n")
    
    lines.append("## Badge Levels\n\n")
    lines.append("- 🥉 **Bronze Contributor** - {} points\n".format(badge_config.get('bronze_contributor', 10)))
    lines.append("- 🥈 **Silver Contributor** - {} points\n".format(badge_config.get('silver_contributor', 25)))
    lines.append("- 🥇 **Gold Contributor** - {} points\n".format(badge_config.get('gold_contributor', 50)))
    lines.append("- 💎 **Platinum Legend** - {} points\n\n".format(badge_config.get('platinum_legend', 100)))
    
    if not items:
        lines.append("_No contributors yet. Be the first!_\n\n")
    else:
        lines.append("| Rank | User | Points | Badge |\n")
        lines.append("|------|------|--------|-------|\n")
        
        for rank, (user, points) in enumerate(items, start=1):
            # Add medal emoji for top 3
            rank_medal = ""
            if rank == 1:
                rank_medal = "🏆 "
            elif rank == 2:
                rank_medal = "🥈 "
            elif rank == 3:
                rank_medal = "🥉 "
            
            # Get badge for points
            badge_name, badge_emoji = get_badge_for_points(points, badge_config)
            badge_display = f"{badge_emoji} {badge_name}" if badge_name else "-"
            
            lines.append(f"| {rank} | {rank_medal}{user} | {points} | {badge_display} |\n")
        
        lines.append("\n")

    # Footer with timestamp (UTC)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    lines.append(f"_Last updated: {ts}_\n")

    return "".join(lines)

def write_markdown(markdown):
    try:
        with open(OUT_MD, 'w', encoding='utf-8') as f:
            f.write(markdown)
        print(f"Leaderboard written to: {OUT_MD}")
    except Exception as e:
        print(f"ERROR: Failed to write LEADERBOARD.md: {e}", file=sys.stderr)
        sys.exit(1)

def main():
    args = parse_args()
    
    print("=" * 60)
    print("Updating Contributor Leaderboard")
    print("=" * 60)
    
    # Load leaderboard with improved error handling
    leaderboard = load_leaderboard(create_if_missing=args.create_if_missing)
    
    # Normalize and sort contributors
    items = normalize_scores(leaderboard)
    items = sort_contributors(items)

    if not items:
        print("No valid contributors found in leaderboard.")
        print("This is normal if no points have been awarded yet.")
    else:
        print(f"Found {len(items)} contributor(s)")

    # Update badge source unless disabled
    write_badge_top(leaderboard, items, no_badge=args.no_badge)

    # Generate Markdown
    md = render_markdown(items, limit=args.limit)
    write_markdown(md)

    top_user = items[0][0] if items else "None"
    print("=" * 60)
    print(f"SUCCESS: Top contributor is {top_user}")
    print("=" * 60)

if __name__ == "__main__":
    main()