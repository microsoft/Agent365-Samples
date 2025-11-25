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
    
    # Allow issue comments only if they're on PRs (for reviews)
    # But allow issue close events (for issue_resolved points)
    action = event.get('action', '')
    if 'comment' in event and 'issue' in event and 'pull_request' not in event.get('issue', {}):
        if action != 'closed':
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
    1. pull_request.user.login (for PR merged events - the PR author)
    2. issue.user.login (for issue closed events - the issue author)
    3. review.user.login (for pull_request_review events)
    4. comment.user.login (for issue_comment events)
    5. sender.login (top-level event sender)
    
    Returns:
        tuple: (user_login: str, source: str) or (None, None) if extraction fails
    """
    # For PR merged events, credit the PR author
    pull_request = event.get('pull_request')
    if pull_request and isinstance(pull_request, dict) and event.get('action') == 'closed' and pull_request.get('merged'):
        pr_user = pull_request.get('user')
        if pr_user and isinstance(pr_user, dict):
            login = pr_user.get('login')
            if login:
                return login, 'pull_request.user'
    
    # For issue closed events, credit the issue author
    issue = event.get('issue')
    if issue and isinstance(issue, dict) and event.get('action') == 'closed' and not pull_request:
        issue_user = issue.get('user')
        if issue_user and isinstance(issue_user, dict):
            login = issue_user.get('login')
            if login:
                return login, 'issue.user'
    
    # Try review user for review events
    review = event.get('review')
    if review and isinstance(review, dict):
        review_user = review.get('user')
        if review_user and isinstance(review_user, dict):
            login = review_user.get('login')
            if login:
                return login, 'review.user'
    
    # Try comment user for comment events
    comment = event.get('comment')
    if comment and isinstance(comment, dict):
        comment_user = comment.get('user')
        if comment_user and isinstance(comment_user, dict):
            login = comment_user.get('login')
            if login:
                return login, 'comment.user'
    
    # Fallback to top-level sender
    sender = event.get('sender')
    if sender and isinstance(sender, dict):
        login = sender.get('login')
        if login:
            return login, 'sender'
    
    # All extraction methods failed
    return None, None

def detect_points(event, cfg):
    """
    Calculate points for a GitHub event based on review content and actions.
    
    All keyword matching is CASE-INSENSITIVE. Contributors can use any capitalization.
    
    Scoring Rules:
    1. Review types (mutually exclusive - only the highest applies):
       - Include "detailed" anywhere in your review = detailed_review points (10)
       - Include "basic review" anywhere in your review = basic_review points (5)
       - If both keywords present, only "detailed" counts (higher value)
    
    2. Bonus points (additive - can stack with review types):
       - Include "performance" anywhere = performance_improvement bonus (+4)
       - Approve the PR (state=approved) = approve_pr bonus (+3)
    
    3. Contribution points (event-based):
       - PR merged = pr_merged points (5)
       - Issue closed = issue_resolved points (1)
       - Documentation changes = documentation points (3)
       - Security fixes = security_fix points (8)
    
    Keyword Examples (all case-insensitive):
    - "detailed", "Detailed", "DETAILED" all work
    - "basic review", "Basic Review", "BASIC REVIEW" all work
    - "performance", "Performance", "PERFORMANCE" all work
    
    Scoring Examples:
    - "This is a basic review" = 5 points
    - "This is a DETAILED analysis" = 10 points (case doesn't matter)
    - "detailed performance review" = 10 + 4 = 14 points
    - Approved PR with "Basic Review" = 5 + 3 = 8 points
    - Approved PR with "Detailed PERFORMANCE review" = 10 + 4 + 3 = 17 points
    - PR merged = 5 points
    - Issue closed with "security" label = 8 points
    """
    action = event.get('action', '')
    review = event.get('review') or {}
    comment = event.get('comment') or {}
    pull_request = event.get('pull_request') or {}
    issue = event.get('issue') or {}

    # Convert to lowercase for case-insensitive matching
    review_body = (review.get('body') or '').lower()
    review_state = (review.get('state') or '').lower()
    comment_body = (comment.get('body') or '').lower()

    user, source = extract_user(event)
    
    if not user:
        print("ERROR: Unable to extract user from event. Checked review.user, comment.user, and sender fields.")
        print("Event structure:", json.dumps({
            'has_review': 'review' in event,
            'has_comment': 'comment' in event,
            'has_sender': 'sender' in event,
            'has_pull_request': 'pull_request' in event,
            'has_issue': 'issue' in event,
            'action': action
        }, indent=2))
        sys.exit(1)
    
    print(f"User identified: {user} (source: {source})")

    points = 0
    scoring_breakdown = []

    # EVENT-BASED SCORING (PR merges, issue closes)
    # Check for PR merged event
    if action == "closed" and pull_request and pull_request.get('merged'):
        points += cfg['points']['pr_merged']
        scoring_breakdown.append(f"pr_merged: +{cfg['points']['pr_merged']}")
        
        # Check for documentation changes (files in docs/, README, *.md)
        files_changed = pull_request.get('changed_files', 0)
        if files_changed > 0:
            # Note: We can't easily check file names here without API call
            # Could check PR title/body for "docs" or "documentation" keywords
            pr_title = (pull_request.get('title') or '').lower()
            pr_body = (pull_request.get('body') or '').lower()
            if 'doc' in pr_title or 'readme' in pr_title or 'doc' in pr_body:
                points += cfg['points']['documentation']
                scoring_breakdown.append(f"documentation: +{cfg['points']['documentation']}")
        
        # Check for security fixes (labels or keywords)
        labels = [label.get('name', '').lower() for label in pull_request.get('labels', [])]
        if 'security' in labels or any('security' in label for label in labels):
            points += cfg['points']['security_fix']
            scoring_breakdown.append(f"security_fix: +{cfg['points']['security_fix']}")
    
    # Check for issue closed event
    elif action == "closed" and issue and not pull_request:
        points += cfg['points']['issue_resolved']
        scoring_breakdown.append(f"issue_resolved: +{cfg['points']['issue_resolved']}")
        
        # Check for security issue
        labels = [label.get('name', '').lower() for label in issue.get('labels', [])]
        if 'security' in labels or any('security' in label for label in labels):
            points += cfg['points']['security_fix']
            scoring_breakdown.append(f"security_fix: +{cfg['points']['security_fix']}")

    # REVIEW-BASED SCORING (original logic)
    # Review type scoring (mutually exclusive - detailed takes precedence)
    # All matching is case-insensitive due to .lower() above
    if "detailed" in review_body:
        points += cfg['points']['detailed_review']
        scoring_breakdown.append(f"detailed_review: +{cfg['points']['detailed_review']}")
    elif "basic review" in review_body:
        points += cfg['points']['basic_review']
        scoring_breakdown.append(f"basic_review: +{cfg['points']['basic_review']}")

    # Performance improvement bonus (additive)
    if "performance" in comment_body or "performance" in review_body:
        points += cfg['points']['performance_improvement']
        scoring_breakdown.append(f"performance_improvement: +{cfg['points']['performance_improvement']}")

    # PR approval bonus (additive)
    if action == "submitted" and review_state == "approved":
        points += cfg['points']['approve_pr']
        scoring_breakdown.append(f"approve_pr: +{cfg['points']['approve_pr']}")

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
    # Priority: review ID > comment ID > PR number > issue number
    event_id = (event.get('review', {}).get('id') or 
                event.get('comment', {}).get('id') or
                event.get('pull_request', {}).get('number') or
                event.get('issue', {}).get('number'))
    
    if not event_id:
        print("No unique ID found in event. Skipping duplicate check.")
        sys.exit(2)  # Exit code 2 = no-op (not an error)
    
    # Create composite ID for PR/issue events to prevent re-scoring on each close
    action = event.get('action', '')
    if action == 'closed':
        event_id = f"{action}_{event_id}"

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