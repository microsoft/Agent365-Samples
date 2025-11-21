import json
import os
import sys
import argparse
from datetime import datetime, timezone

LB_JSON = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'leaderboard.json')
OUT_MD = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'LEADERBOARD.md')

def parse_args():
    parser = argparse.ArgumentParser(
        description="Update LEADERBOARD.md from leaderboard.json and set the 'top' contributor for the README badge."
    )
    parser.add_argument("--limit", type=int, default=0,
                        help="Show only the top N contributors in LEADERBOARD.md (0 = show all).")
    parser.add_argument("--no-badge", action="store_true",
                        help="Do not write the 'top' key back into leaderboard.json.")
    return parser.parse_args()

def load_leaderboard():
    if not os.path.exists(LB_JSON):
        print("No leaderboard.json found. Run assign_points first.", file=sys.stderr)
        return {}

    try:
        with open(LB_JSON, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        print(f"leaderboard.json is invalid JSON: {e}", file=sys.stderr)
        return {}

    if not isinstance(data, dict):
        print("leaderboard.json must be a JSON object mapping 'user' -> points.", file=sys.stderr)
        return {}

    return data

def normalize_scores(leaderboard):
    """
    Ensure points are integers and filter out non-user keys other than 'top'.
    Returns a list of (user, points) tuples suitable for sorting.
    """
    items = []
    for user, points in leaderboard.items():
        if user == 'top':
            # ignore; recomputed below
            continue
        try:
            # Convert numeric strings/floats to int safely
            points_int = int(float(points))
        except (ValueError, TypeError):
            # If points cannot be parsed, skip this user
            print(f"Skipping '{user}' due to non-numeric points: {points}", file=sys.stderr)
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
    except Exception as e:
        print(f"Failed to write updated leaderboard.json: {e}", file=sys.stderr)
        # Non-fatal: continue to write the MD even if we couldn’t update the badge key

def render_markdown(items, limit=0):
    """
    Build the markdown leaderboard table with optional row limit and a 'Last updated' footer.
    """
    if limit > 0:
        items = items[:limit]

    lines = []
    lines.append("# Contributor Leaderboard\n")
    lines.append("| User | Points |\n|------|--------|\n")

    for user, points in items:
        lines.append(f"| {user} | {points} |\n")

    # Footer with timestamp (UTC)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    lines.append(f"\n_Last updated: {ts}_\n")

    return "".join(lines)

def write_markdown(markdown):
    try:
        with open(OUT_MD, 'w', encoding='utf-8') as f:
            f.write(markdown)
    except Exception as e:
        print(f"Failed to write LEADERBOARD.md: {e}", file=sys.stderr)
        sys.exit(1)

def main():
    args = parse_args()
    leaderboard = load_leaderboard()
    if not leaderboard:
        # No leaderboard or invalid; stop quietly (non-zero for CI visibility)
        sys.exit(1)

    items = normalize_scores(leaderboard)
    items = sort_contributors(items)

    # Update badge source unless disabled
    write_badge_top(leaderboard, items, no_badge=args.no_badge)

    # Generate Markdown
    md = render_markdown(items, limit=args.limit)
    write_markdown(md)

    top_user = items[0][0] if items else "None"
    print(f"Leaderboard updated. Top contributor: {top_user}")

if __name__ == "__main__":
    main()