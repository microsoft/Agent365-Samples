# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Contributor Points Tracker

This script:
1. Monitors all PR-related events (reviews, comments, approvals, merges, etc.)
2. Calculates points for all contributors on a PR
3. Updates a single PR comment with live point tracking
4. Exports metadata in comment for external pipeline to parse and store in Kusto

Supported events:
- pull_request_review (submitted, edited, dismissed)
- issue_comment (on PRs only)
- pull_request (opened, closed, labeled, etc.)
- pull_request_review_comment

Points are calculated based on:
- Review submission: 5 points
- Detailed review (100+ chars): +5 bonus
- PR approval: +3 bonus
- PR comment: 2 points
- PR merged: 5 points (for author)
- Bug fix (labeled): +5 bonus
- High priority: +3 bonus
- Test coverage: +8 points
- Documentation: +4 points
- First-time contributor: +5 bonus
"""

import os
import sys
import json
import yaml
import requests
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

# Configuration
CONFIG_FILE = os.path.join(os.path.dirname(__file__), 'config_points.yml')
GITHUB_TOKEN = os.getenv('GITHUB_TOKEN')
GITHUB_REPOSITORY = os.getenv('GITHUB_REPOSITORY')  # Format: owner/repo
GITHUB_EVENT_NAME = os.getenv('GITHUB_EVENT_NAME')
GITHUB_EVENT_PATH = os.getenv('GITHUB_EVENT_PATH')

# Comment identifier for finding the bot's tracking comment
COMMENT_MARKER = "<!-- CONTRIBUTOR_POINTS_TRACKER -->"

# Keywords for detecting performance improvement suggestions in reviews
PERFORMANCE_KEYWORDS = [
    'performance', 'performant', 'optimization', 'optimize', 
    'fast', 'faster', 'efficient', 'efficiency', 'speed'
]

def load_config() -> dict:
    """Load points configuration from YAML file."""
    if not os.path.exists(CONFIG_FILE):
        print(f"ERROR: Config file not found: {CONFIG_FILE}", file=sys.stderr)
        sys.exit(1)
    
    try:
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            config = yaml.safe_load(f)
        
        # Validate required keys exist
        required_keys = ['review_submission', 'detailed_review', 'approve_pr', 'pr_merged']
        if 'points' not in config:
            print(f"ERROR: Config missing 'points' section", file=sys.stderr)
            sys.exit(1)
        
        missing = [key for key in required_keys if key not in config['points']]
        if missing:
            print(f"ERROR: Config missing required keys: {missing}", file=sys.stderr)
            sys.exit(1)
        
        return config
    except Exception as e:
        print(f"ERROR: Failed to load config: {e}", file=sys.stderr)
        sys.exit(1)

def load_event() -> dict:
    """Load GitHub event payload."""
    if not GITHUB_EVENT_PATH or not os.path.exists(GITHUB_EVENT_PATH):
        print(f"ERROR: Event file not found: {GITHUB_EVENT_PATH}", file=sys.stderr)
        sys.exit(1)
    
    try:
        with open(GITHUB_EVENT_PATH, 'r', encoding='utf-8') as f:
            event = json.load(f)
        return event
    except Exception as e:
        print(f"ERROR: Failed to load event: {e}", file=sys.stderr)
        sys.exit(1)

def get_pr_number(event: dict) -> Optional[int]:
    """Extract PR number from event."""
    if 'pull_request' in event:
        return event['pull_request']['number']
    elif 'issue' in event and 'pull_request' in event['issue']:
        return event['issue']['number']
    elif 'review' in event:
        pr_url = event['review'].get('pull_request_url', '')
        if pr_url:
            try:
                return int(pr_url.split('/')[-1])
            except (ValueError, IndexError):
                print(f"WARNING: Could not parse PR number from URL: {pr_url}", file=sys.stderr)
                return None
    return None

def get_issue_number(event: dict) -> Optional[int]:
    """Extract issue number from event (for non-PR issues only)."""
    if 'issue' in event and 'pull_request' not in event['issue']:
        return event['issue']['number']
    return None

def is_issue_event(event: dict) -> bool:
    """Check if this is an issue event (not a PR)."""
    return GITHUB_EVENT_NAME == 'issues' or (GITHUB_EVENT_NAME == 'issue_comment' and 'issue' in event and 'pull_request' not in event['issue'])

def github_api_request(method: str, endpoint: str, data: Optional[dict] = None) -> dict:
    """Make GitHub API request."""
    url = f"https://api.github.com/repos/{GITHUB_REPOSITORY}/{endpoint}"
    headers = {
        'Authorization': f'token {GITHUB_TOKEN}',
        'Accept': 'application/vnd.github.v3+json'
    }
    
    try:
        if method == 'GET':
            response = requests.get(url, headers=headers)
        elif method == 'POST':
            response = requests.post(url, headers=headers, json=data)
        elif method == 'PATCH':
            response = requests.patch(url, headers=headers, json=data)
        
        response.raise_for_status()
        return response.json() if response.text else {}
    except Exception as e:
        print(f"ERROR: GitHub API request failed: {e}", file=sys.stderr)
        return {}

def get_all_pr_activity(pr_number: int) -> Tuple[List[dict], List[dict], dict]:
    """
    Fetch all activity on a PR: reviews, comments, and PR details.
    
    Returns:
        Tuple of (reviews, comments, pr_details)
    """
    reviews = github_api_request('GET', f'pulls/{pr_number}/reviews')
    comments = github_api_request('GET', f'issues/{pr_number}/comments')
    pr_details = github_api_request('GET', f'pulls/{pr_number}')
    
    return (
        reviews if isinstance(reviews, list) else [],
        comments if isinstance(comments, list) else [],
        pr_details if isinstance(pr_details, dict) else {}
    )

def calculate_review_points(review: dict, config: dict) -> Tuple[int, List[str]]:
    """Calculate points for a single review."""
    points = config['points']['review_submission']  # Base: 5 points
    breakdown = ['Review submission: +5 points']
    
    # Detailed review bonus (100+ characters)
    body = review.get('body', '').strip()
    if len(body) >= 100:
        points += config['points']['detailed_review']  # +5 points
        breakdown.append(f'Detailed feedback ({len(body)} characters): +5 points')
    
    # Performance improvement suggestion bonus
    body_lower = body.lower()
    if any(keyword in body_lower for keyword in PERFORMANCE_KEYWORDS):
        bonus = config['points'].get('performance_improvement', 6)
        points += bonus
        breakdown.append(f'Performance improvement suggestion: +{bonus} points')

    # Approval bonus
    if review.get('state') == 'APPROVED':
        points += config['points']['approve_pr']  # +3 points
        breakdown.append('Approved PR: +3 points')
    
    return points, breakdown

def calculate_pr_author_points(pr_details: dict, config: dict) -> Tuple[int, List[str]]:
    """Calculate points for PR author based on PR characteristics."""
    points = 0
    breakdown = []
    
    # PR merged
    if pr_details.get('merged'):
        points += config['points'].get('pr_merged', 5)
        breakdown.append('PR merged: +5 points')
    
    # Check labels for bonuses
    labels = [label['name'].lower() for label in pr_details.get('labels', [])]
    
    # Bug fix: Check if PR is linked to an issue with 'bug' label
    linked_issues = get_linked_issues(pr_details)
    for issue in linked_issues:
        issue_labels = [label['name'].lower() for label in issue.get('labels', [])]
        if any('bug' in label for label in issue_labels):
            bonus = config['points'].get('bug_fix', 5)
            points += bonus
            breakdown.append(f'Bug fix (closes issue #{issue["number"]}): +{bonus} points')
            break  # Only award once even if multiple bug issues linked
    
    # Security fix: Check if PR is linked to a security issue OR has security labels
    has_security = any('security' in label or 'vulnerability' in label for label in labels)
    
    # Also check linked issues for security labels (only if not already found)
    if not has_security:
        for issue in linked_issues:
            issue_labels = [label['name'].lower() for label in issue.get('labels', [])]
            if any('security' in label or 'vulnerability' in label for label in issue_labels):
                has_security = True
                breakdown_source = f'closes issue #{issue["number"]}'
                break
    else:
        breakdown_source = 'PR labeled'
    
    # Award security bonus only once
    if has_security:
        bonus = config['points'].get('security_fix', 15)
        points += bonus
        breakdown.append(f'Security fix ({breakdown_source}): +{bonus} points')
    
    # Documentation: Check both labels AND files changed
    has_docs = any('documentation' in label or 'docs' in label for label in labels)
    
    # Also check if PR modifies documentation files
    if not has_docs:
        pr_number = pr_details.get('number')
        if pr_number:
            files = github_api_request('GET', f'pulls/{pr_number}/files')
            if isinstance(files, list):
                has_docs = any(
                    'readme' in f['filename'].lower() or
                    'docs/' in f['filename'].lower() or
                    f['filename'].lower().endswith('.md')
                    for f in files if f.get('additions', 0) > 0
                )
    
    if has_docs:
        bonus = config['points'].get('documentation', 4)
        points += bonus
        breakdown.append(f'Documentation: +{bonus} points')
    
    # Check if first-time contributor
    author = pr_details.get('user', {}).get('login')
    pr_number = pr_details.get('number')
    if author and pr_number and is_first_time_contributor(author, pr_number):
        bonus = config['points'].get('first_time_contributor', 5)
        points += bonus
        breakdown.append(f'First-time contributor: +{bonus} points')
    
    return points, breakdown

def get_linked_issues(pr_details: dict) -> List[dict]:
    """Get issues linked to this PR by checking PR body for closing keywords."""
    linked_issues = []
    pr_body = pr_details.get('body', '') or ''
    pr_number = pr_details.get('number')
    
    # Keywords that link issues: closes, fixes, resolves (case-insensitive)
    import re
    # Pattern matches: "closes #123", "fixes #456", "resolves #789", etc.
    pattern = r'(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)'
    matches = re.findall(pattern, pr_body, re.IGNORECASE)
    
    for issue_number in matches:
        issue = github_api_request('GET', f'issues/{issue_number}')
        if issue and isinstance(issue, dict):
            linked_issues.append(issue)
    
    return linked_issues

def is_first_time_contributor(username: str, current_pr_number: int) -> bool:
    """Check if the current PR is the user's first merged PR."""
    # Check if user has any other merged PRs (excluding current one)
    # Limit to recent 100 PRs to avoid API rate limits and performance issues
    try:
        search_result = github_api_request('GET', f'pulls?state=all&creator={username}&per_page=100')
        if isinstance(search_result, list):
            # Get all merged PRs excluding the current one
            other_merged_prs = [
                pr for pr in search_result 
                if pr.get('merged_at') and pr.get('number') != current_pr_number
            ]
            # First-time contributor if no other merged PRs exist
            return len(other_merged_prs) == 0
    except Exception as e:
        print(f"WARNING: Error checking first-time contributor status: {e}", file=sys.stderr)
    return False

def calculate_issue_points(issue: dict, config: dict) -> Tuple[int, List[str]]:
    """Calculate points for issue creator based on priority."""
    points = 0
    breakdown = []
    
    labels = [label['name'].lower() for label in issue.get('labels', [])]
    
    # High priority issue creation
    if any('priority' in label and 'high' in label for label in labels):
        bonus = config['points'].get('high_priority', 3)
        points += bonus
        breakdown.append(f'High priority issue created: +{bonus} points')
    
    # Critical bug issue
    if any('critical' in label and 'bug' in label for label in labels):
        bonus = config['points'].get('critical_bug', 10)
        points += bonus
        breakdown.append(f'Critical bug reported: +{bonus} points')
    
    # Security vulnerability reported
    if any('security' in label or 'vulnerability' in label for label in labels):
        bonus = config['points'].get('security_fix', 15)
        points += bonus
        breakdown.append(f'Security vulnerability reported: +{bonus} points')
    
    return points, breakdown

def aggregate_contributor_points(reviews: List[dict], comments: List[dict], pr_details: dict, config: dict) -> Dict[str, dict]:
    """
    Aggregate points for all contributors on a PR.
    
    Returns:
        Dict mapping username to {'total': int, 'activities': [list of activity dicts]}
    """
    contributors = {}
    
    # Process reviews
    for review in reviews:
        username = review['user']['login']
        if username not in contributors:
            contributors[username] = {'total': 0, 'activities': []}
        
        points, breakdown = calculate_review_points(review, config)
        contributors[username]['total'] += points
        contributors[username]['activities'].append({
            'type': 'review',
            'points': points,
            'breakdown': breakdown,
            'timestamp': review['submitted_at'],
            'state': review['state']
        })
    
    # Add PR author points (if PR is merged or has special labels)
    pr_author = pr_details.get('user', {}).get('login')
    if pr_author:
        author_points, author_breakdown = calculate_pr_author_points(pr_details, config)
        if author_points > 0:
            if pr_author not in contributors:
                contributors[pr_author] = {'total': 0, 'activities': []}
            
            contributors[pr_author]['total'] += author_points
            contributors[pr_author]['activities'].append({
                'type': 'pr_author',
                'points': author_points,
                'breakdown': author_breakdown,
                'timestamp': pr_details.get('merged_at') or pr_details.get('created_at')
            })
    
    return contributors

def format_comment_body(pr_number: int, contributors: Dict[str, dict]) -> str:
    """Format the PR comment body with points tracking."""
    total_points = sum(c['total'] for c in contributors.values())
    timestamp = datetime.now(timezone.utc).strftime('%B %d, %Y at %I:%M %p UTC')
    
    # Header
    comment = f"{COMMENT_MARKER}\n\n"
    comment += "## 🏆 Contributor Points Tracker\n\n"
    comment += f"**Total Points on This PR: {total_points} points**\n\n"
    comment += "### Points by Contributor\n\n"
    
    # Sort contributors by points (descending)
    sorted_contributors = sorted(contributors.items(), key=lambda x: x[1]['total'], reverse=True)
    
    for username, data in sorted_contributors:
        comment += f"#### @{username} - **{data['total']} points**\n\n"
        
        # Group activities by type
        for activity in data['activities']:
            timestamp_str = activity['timestamp'].split('T')[0]  # Just the date
            comment += f"**{activity['type'].replace('_', ' ').title()}** ({timestamp_str}):\n"
            for item in activity['breakdown']:
                comment += f"- ✅ {item}\n"
            comment += "\n"
    
    # Footer
    comment += "---\n\n"
    comment += "### How Points Are Calculated\n\n"
    comment += "| Action | Points |\n"
    comment += "|--------|--------|\n"
    comment += "| Review submission | 5 |\n"
    comment += "| Detailed review (100+ chars) | +5 bonus |\n"
    comment += "| Performance improvement suggestion | +6 bonus |\n"
    comment += "| PR approval | +3 bonus |\n"
    comment += "| PR merged | 5 |\n"
    comment += "| Bug fix (closes issue) | +5 bonus |\n"
    comment += "| Security fix/vulnerability | +15 bonus |\n"
    comment += "| Documentation | +4 bonus |\n"
    comment += "| First-time contributor | +5 bonus |\n"
    comment += "| High priority issue created | +3 bonus |\n"
    comment += "| Critical bug reported | +10 bonus |\n\n"
    comment += f"*Last updated: {timestamp}*\n\n"
    
    # Metadata for external pipeline parsing
    metadata = {
        'pr_number': pr_number,
        'total_points': total_points,
        'contributors': {
            username: {
                'total': data['total'],
                'activity_count': len(data['activities'])
            }
            for username, data in contributors.items()
        },
        'last_updated': datetime.now(timezone.utc).isoformat()
    }
    comment += f"<!-- POINTS_DATA\n{json.dumps(metadata, indent=2)}\n-->\n"
    
    return comment

def find_existing_comment(pr_number: int) -> Optional[int]:
    """Find the bot's existing tracking comment on the PR."""
    comments = github_api_request('GET', f'issues/{pr_number}/comments')
    if not isinstance(comments, list):
        return None
    
    for comment in comments:
        if COMMENT_MARKER in comment.get('body', ''):
            return comment['id']
    
    return None

def update_or_create_comment(pr_number: int, body: str):
    """Update existing tracking comment or create a new one."""
    existing_comment_id = find_existing_comment(pr_number)
    
    if existing_comment_id:
        # Update existing comment
        result = github_api_request('PATCH', f'issues/comments/{existing_comment_id}', {'body': body})
        print(f"✅ Updated tracking comment (ID: {existing_comment_id})")
    else:
        # Create new comment
        result = github_api_request('POST', f'issues/{pr_number}/comments', {'body': body})
        print(f"✅ Created new tracking comment")

def main():
    """Main execution function."""
    if not GITHUB_TOKEN:
        print("ERROR: GITHUB_TOKEN not set", file=sys.stderr)
        sys.exit(1)
    
    print(f"🔄 Processing {GITHUB_EVENT_NAME} event...")
    
    # Load configuration and event
    config = load_config()
    event = load_event()
    
    # Check if this is an issue event (not a PR)
    if is_issue_event(event):
        print("📋 Processing issue event...")
        issue_number = get_issue_number(event)
        if not issue_number:
            print("ℹ️  Could not extract issue number")
            sys.exit(0)
        
        # Get issue details
        issue = github_api_request('GET', f'issues/{issue_number}')
        if not issue or not isinstance(issue, dict):
            print("❌ Failed to fetch issue details")
            sys.exit(1)
        
        # Calculate points for issue creator
        issue_creator = issue.get('user', {}).get('login')
        points, breakdown = calculate_issue_points(issue, config)
        
        if points > 0 and issue_creator:
            print(f"   Issue #{issue_number} by @{issue_creator}: {points} points")
            for item in breakdown:
                print(f"   - {item}")
            print("ℹ️  External pipeline should parse this event and store in Kusto")
        else:
            print("ℹ️  No points awarded for this issue")
        
        sys.exit(0)
    
    # Handle PR events
    pr_number = get_pr_number(event)
    if not pr_number:
        print("ℹ️  Not a PR-related event, skipping")
        sys.exit(0)
    
    print(f"📝 Processing PR #{pr_number}...")
    
    # Fetch all PR activity
    reviews, comments, pr_details = get_all_pr_activity(pr_number)
    print(f"   Found {len(reviews)} reviews and {len(comments)} comments")
    
    # Calculate points for all contributors
    contributors = aggregate_contributor_points(reviews, comments, pr_details, config)
    print(f"   Calculated points for {len(contributors)} contributors")
    
    if not contributors:
        print("ℹ️  No points to award yet")
        sys.exit(0)
    
    # Format and update comment
    comment_body = format_comment_body(pr_number, contributors)
    update_or_create_comment(pr_number, comment_body)
    
    print("✅ Points tracking complete!")
    print("ℹ️  External pipeline can parse comment metadata for Kusto ingestion")

if __name__ == '__main__':
    main()
