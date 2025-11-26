# Copyright (c) Microsoft. All rights reserved.

import os
import json
import yaml
import sys

# Exit codes used by this script:
# 0 = Success - points were awarded and leaderboard updated
# 1 = Error - something went wrong (missing config, permissions, etc.)
# 2 = No-op - no points awarded, but not an error (duplicate event, no criteria matched)

# Path to config file inside scripts folder
CONFIG_FILE = os.path.join(os.path.dirname(__file__), 'config_points.yml')
PROCESSED_FILE = os.path.join(os.path.dirname(__file__), 'processed_ids.json')
# Path to leaderboard in repository root (one level up from scripts/)
LEADERBOARD_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'leaderboard.json')

def load_config():
    """
    Load the points configuration from config_points.yml.
    
    Returns:
        dict: Configuration dictionary with 'points' section
    
    Exits:
        1 if config file is missing or contains invalid YAML
    """
    if not os.path.exists(CONFIG_FILE):
        print(f"ERROR: Config file not found: {CONFIG_FILE}", file=sys.stderr)
        print("Expected location: scripts/config_points.yml", file=sys.stderr)
        sys.exit(1)
    
    try:
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            config = yaml.safe_load(f)
    except yaml.YAMLError as e:
        print(f"ERROR: Invalid YAML syntax in config file: {e}", file=sys.stderr)
        print(f"File location: {CONFIG_FILE}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: Failed to read config file: {e}", file=sys.stderr)
        sys.exit(1)
    
    # Validate that config has the expected structure
    if not isinstance(config, dict) or 'points' not in config:
        print(f"ERROR: Invalid config structure in {CONFIG_FILE}", file=sys.stderr)
        print("Expected format: { points: { basic_review: 5, ... } }", file=sys.stderr)
        sys.exit(1)
    
    return config

def load_event():
    event_path = os.getenv('GITHUB_EVENT_PATH')
    if not event_path:
        print("ERROR: GITHUB_EVENT_PATH is not set.")
        sys.exit(1)
    if not os.path.exists(event_path):
        print(f"ERROR: Event file not found: {event_path}")
        sys.exit(1)
    with open(event_path, 'r', encoding='utf-8') as f:
        event = json.load(f)
    
    # Validate that this is a PR-related event, not a regular issue comment
    if 'issue' in event and 'pull_request' not in event.get('issue', {}):
        print("INFO: Skipping - this is a comment on a regular issue, not a pull request.")
        sys.exit(2)  # Exit code 2 = no-op
    
    return event

def load_processed_ids():
    if os.path.exists(PROCESSED_FILE):
        with open(PROCESSED_FILE, 'r', encoding='utf-8') as f:
            try:
                return json.load(f)
            except json.JSONDecodeError:
                return []
    return []

def save_processed_ids(ids):
    """
    Save processed event IDs to prevent duplicate scoring.
    
    This is critical for data integrity - if this fails after points
    are awarded, the same event could be scored multiple times on retry.
    """
    try:
        with open(PROCESSED_FILE, 'w', encoding='utf-8') as f:
            json.dump(ids, f, indent=2)
    except PermissionError as e:
        print(f"ERROR: Permission denied when saving processed IDs to {PROCESSED_FILE}: {e}", file=sys.stderr)
        print("Check file permissions and ensure the workflow has write access.", file=sys.stderr)
        sys.exit(1)
    except IOError as e:
        print(f"ERROR: Failed to write processed IDs to {PROCESSED_FILE}: {e}", file=sys.stderr)
        print("This may be due to disk space issues or file system problems.", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: Unexpected error saving processed IDs: {e}", file=sys.stderr)
        sys.exit(1)

def extract_user(event):
    """
    Extract user login from GitHub event with multiple fallback strategies.
    
    Priority:
    1. review.user.login (for pull_request_review events)
    2. comment.user.login (for issue_comment events)
    3. sender.login (top-level event sender)
    
    Returns:
        tuple: (user_login: str, source: str) or (None, None) if extraction fails
    """
    # Try review user first
    review = event.get('review')
    if review and isinstance(review, dict):
        review_user = review.get('user')
        if review_user and isinstance(review_user, dict):
            login = review_user.get('login')
            if login:
                return login, 'review.user'
    
    # Try comment user second
    comment = event.get('comment')
    if comment and isinstance(comment, dict):
        comment_user = comment.get('user')
        if comment_user and isinstance(comment_user, dict):
            login = comment_user.get('login')
            if login:
                return login, 'comment.user'
    
    # Fallback to top-level sender (most reliable)
    sender = event.get('sender')
    if sender and isinstance(sender, dict):
        login = sender.get('login')
        if login:
            return login, 'sender'
    
    # All extraction methods failed
    return None, None

def detect_points(event, cfg):
    """
    Calculate points for a GitHub event based on review actions.
    
    Scoring Rules:
    1. Any PR review submission = review_submission points (base points)
    2. PR approval (state=approved) = approve_pr bonus (additive)
    3. Substantial review (comment length >= 100 characters) = detailed_review bonus (additive)
    
    Scoring Examples:
    - Simple review with short comment = 5 points (base)
    - Review with detailed feedback (100+ chars) = 5 + 5 = 10 points
    - Approved PR = 5 + 3 = 8 points
    - Approved PR with detailed feedback = 5 + 3 + 5 = 13 points
    - Comment on PR (not a review) = 2 points
    """
    action = event.get('action', '')
    review = event.get('review') or {}
    comment = event.get('comment') or {}

    review_body = review.get('body') or ''
    review_state = (review.get('state') or '').lower()
    comment_body = comment.get('body') or ''

    user, source = extract_user(event)
    
    if not user:
        print("ERROR: Unable to extract user from event. Checked review.user, comment.user, and sender fields.")
        print("Event structure:", json.dumps({
            'has_review': 'review' in event,
            'has_comment': 'comment' in event,
            'has_sender': 'sender' in event,
            'action': action
        }, indent=2))
        sys.exit(1)
    
    print(f"User identified: {user} (source: {source})")

    points = 0
    scoring_breakdown = []

    # Determine if this is a review or just a comment
    is_review = action == "submitted" and 'review' in event
    is_comment = 'comment' in event and 'review' not in event

    if is_review:
        # Base points for any PR review submission
        points += cfg['points']['review_submission']
        scoring_breakdown.append(f"review_submission: +{cfg['points']['review_submission']}")
        
        # Bonus for substantial review (100+ characters)
        if len(review_body.strip()) >= 100:
            points += cfg['points']['detailed_review']
            scoring_breakdown.append(f"detailed_review: +{cfg['points']['detailed_review']}")
        
        # Bonus for approving the PR
        if review_state == "approved":
            points += cfg['points']['approve_pr']
            scoring_breakdown.append(f"approve_pr: +{cfg['points']['approve_pr']}")
    
    elif is_comment:
        # Points for commenting on a PR (less than review)
        points += cfg['points']['pr_comment']
        scoring_breakdown.append(f"pr_comment: +{cfg['points']['pr_comment']}")

    # Log scoring breakdown for transparency
    if scoring_breakdown:
        print(f"Scoring breakdown: {', '.join(scoring_breakdown)} = {points} total")
    else:
        print("No scoring criteria matched.")

    return points, user

def update_leaderboard(user, points):
    """
    Update the leaderboard with awarded points for a user.
    
    Args:
        user: GitHub username
        points: Points to award
    """
    leaderboard = {}

    if os.path.exists(LEADERBOARD_FILE):
        with open(LEADERBOARD_FILE, 'r', encoding='utf-8') as f:
            try:
                leaderboard = json.load(f)
            except json.JSONDecodeError:
                leaderboard = {}

    leaderboard[user] = leaderboard.get(user, 0) + points

    try:
        with open(LEADERBOARD_FILE, 'w', encoding='utf-8') as f:
            json.dump(leaderboard, f, indent=2)
    except PermissionError as e:
        print(f"ERROR: Permission denied when saving leaderboard to {LEADERBOARD_FILE}: {e}", file=sys.stderr)
        print("Check file permissions and ensure the workflow has write access.", file=sys.stderr)
        sys.exit(1)
    except IOError as e:
        print(f"ERROR: Failed to write leaderboard to {LEADERBOARD_FILE}: {e}", file=sys.stderr)
        print("This may be due to disk space issues or file system problems.", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: Unexpected error saving leaderboard: {e}", file=sys.stderr)
        sys.exit(1)

def main():
    cfg = load_config()
    event = load_event()
    points, user = detect_points(event, cfg)

    # Extract unique ID for duplicate prevention
    event_id = event.get('review', {}).get('id') or event.get('comment', {}).get('id')
    if not event_id:
        print("No unique ID found in event. Skipping duplicate check.")
        sys.exit(2)  # Exit code 2 = no-op (not an error)

    processed_ids = load_processed_ids()
    if event_id in processed_ids:
        print(f"Event {event_id} already processed. Skipping scoring.")
        sys.exit(2)  # Exit code 2 = no-op (not an error)

    if points <= 0:
        print("No points awarded for this event.")
        sys.exit(2)  # Exit code 2 = no-op (not an error)

    # Update leaderboard first, then mark as processed
    # This order ensures we can retry if processed_ids save fails
    update_leaderboard(user, points)
    processed_ids.append(event_id)
    save_processed_ids(processed_ids)
    print(f"Points awarded: {points} to {user}")
    sys.exit(0)  # Exit code 0 = success (points awarded)

if __name__ == "__main__":
    main()