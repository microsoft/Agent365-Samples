import os
import json
import yaml
import sys

# Path to config file inside scripts folder
CONFIG_FILE = os.path.join(os.path.dirname(__file__), 'config_points.yml')
PROCESSED_FILE = os.path.join(os.path.dirname(__file__), 'processed_ids.json')

def load_config():
    with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
        return yaml.safe_load(f)

def load_event():
    event_path = os.getenv('GITHUB_EVENT_PATH')
    if not event_path:
        print("ERROR: GITHUB_EVENT_PATH is not set.")
        sys.exit(1)
    if not os.path.exists(event_path):
        print(f"ERROR: Event file not found: {event_path}")
        sys.exit(1)
    with open(event_path, 'r', encoding='utf-8') as f:
        return json.load(f)

def load_processed_ids():
    if os.path.exists(PROCESSED_FILE):
        with open(PROCESSED_FILE, 'r', encoding='utf-8') as f:
            try:
                return json.load(f)
            except json.JSONDecodeError:
                return []
    return []

def save_processed_ids(ids):
    with open(PROCESSED_FILE, 'w', encoding='utf-8') as f:
        json.dump(ids, f, indent=2)

def detect_points(event, cfg):
    action = event.get('action', '')
    review = event.get('review') or {}
    comment = event.get('comment') or {}

    review_body = (review.get('body') or '').lower()
    review_state = (review.get('state') or '').lower()
    comment_body = (comment.get('body') or '').lower()

    user = (review.get('user', {}) or {}).get('login') or (comment.get('user', {}) or {}).get('login') or "unknown"

    points = 0

    # Additive scoring logic
    if "basic review" in review_body:
        points += cfg['points']['basic_review']
    if "detailed" in review_body:
        points += cfg['points']['detailed_review']
    if "performance" in comment_body or "performance" in review_body:
        points += cfg['points']['performance_improvement']
    if action == "submitted" and review_state == "approved":
        points += cfg['points']['approve_pr']

    return points, user

def update_leaderboard(user, points):
    lb_path = 'leaderboard.json'
    leaderboard = {}

    if os.path.exists(lb_path):
        with open(lb_path, 'r', encoding='utf-8') as f:
            try:
                leaderboard = json.load(f)
            except json.JSONDecodeError:
                leaderboard = {}

    leaderboard[user] = leaderboard.get(user, 0) + points

    with open(lb_path, 'w', encoding='utf-8') as f:
        json.dump(leaderboard, f, indent=2)

def main():
    cfg = load_config()
    event = load_event()
    points, user = detect_points(event, cfg)

    # Extract unique ID for duplicate prevention
    event_id = event.get('review', {}).get('id') or event.get('comment', {}).get('id')
    if not event_id:
        print("No unique ID found in event. Skipping duplicate check.")
        return

    processed_ids = load_processed_ids()
    if event_id in processed_ids:
        print(f"Event {event_id} already processed. Skipping scoring.")
        return

    if points <= 0:
        print("No points awarded for this event.")
        return

    update_leaderboard(user, points)
    processed_ids.append(event_id)
    save_processed_ids(processed_ids)
    print(f"Points awarded: {points} to {user}")

if __name__ == "__main__":
    main()