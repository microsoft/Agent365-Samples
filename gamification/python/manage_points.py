# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Simple command-line tool for awarding points to contributors.
No webhook setup required - maintainers can run this manually.
"""

import sys
from database import GamificationDatabase
from points_service import PointsService


def show_menu():
    """Display main menu."""
    print("\n" + "="*60)
    print("  🎮 Agent365-Samples Gamification - Point Manager")
    print("="*60)
    print("\n📋 Quick Actions:")
    print("  1. Award points for merged PR")
    print("  2. Award points for closed issue")
    print("  3. Award points for code review")
    print("  4. Award points for documentation")
    print("  5. Custom point award")
    print("  6. View contributor profile")
    print("  7. View leaderboard")
    print("  8. Exit")


def award_pr_points():
    """Award points for a merged PR."""
    username = input("\n👤 GitHub username: ").strip()
    pr_number = input("🔢 PR number: ").strip()
    
    priority = input("⚡ Priority (LOW/MEDIUM/HIGH/CRITICAL) [MEDIUM]: ").strip().upper() or "MEDIUM"
    is_bug = input("🐛 Is this a bug fix? (y/n) [n]: ").strip().lower() == 'y'
    
    db = GamificationDatabase()
    service = PointsService(db)
    
    result = service.award_points(
        username,
        'pr_merged',
        {
            'pr_number': int(pr_number),
            'priority': priority,
            'is_bug_fix': is_bug
        }
    )
    
    print(f"\n✅ Awarded {result['points_earned']} points to {username}!")
    print(f"   Total points: {result['total_points']}")
    if result['new_badges']:
        print(f"   🎖️  New badges: {', '.join(result['new_badges'])}")
    
    db.close()


def award_issue_points():
    """Award points for closing an issue."""
    username = input("\n👤 GitHub username: ").strip()
    issue_number = input("🔢 Issue number: ").strip()
    
    priority = input("⚡ Priority (LOW/MEDIUM/HIGH/CRITICAL) [MEDIUM]: ").strip().upper() or "MEDIUM"
    is_security = input("🛡️  Is this a security issue? (y/n) [n]: ").strip().lower() == 'y'
    
    db = GamificationDatabase()
    service = PointsService(db)
    
    action = 'security_fix' if is_security else 'issue_closed'
    
    result = service.award_points(
        username,
        action,
        {
            'issue_number': int(issue_number),
            'priority': priority,
            'is_security': is_security
        }
    )
    
    print(f"\n✅ Awarded {result['points_earned']} points to {username}!")
    print(f"   Total points: {result['total_points']}")
    if result['new_badges']:
        print(f"   🎖️  New badges: {', '.join(result['new_badges'])}")
    
    db.close()


def award_review_points():
    """Award points for code review."""
    username = input("\n👤 GitHub username: ").strip()
    pr_number = input("🔢 PR number reviewed: ").strip()
    
    print("\n📝 Review type:")
    print("  1. Basic review")
    print("  2. Detailed review with comments")
    print("  3. Performance suggestion")
    print("  4. Approval after changes")
    
    choice = input("Select (1-4) [1]: ").strip() or "1"
    
    action_map = {
        '1': 'review_basic',
        '2': 'review_detailed',
        '3': 'review_performance_suggestion',
        '4': 'review_approve'
    }
    
    action = action_map.get(choice, 'review_basic')
    
    db = GamificationDatabase()
    service = PointsService(db)
    
    result = service.award_points(
        username,
        action,
        {'pr_number': int(pr_number)}
    )
    
    print(f"\n✅ Awarded {result['points_earned']} points to {username}!")
    print(f"   Total points: {result['total_points']}")
    if result['new_badges']:
        print(f"   🎖️  New badges: {', '.join(result['new_badges'])}")
    
    db.close()


def award_doc_points():
    """Award points for documentation."""
    username = input("\n👤 GitHub username: ").strip()
    
    print("\n📚 Documentation type:")
    print("  1. README update")
    print("  2. Tutorial/Wiki page")
    print("  3. Video demo")
    
    choice = input("Select (1-3) [1]: ").strip() or "1"
    
    action_map = {
        '1': 'readme_update',
        '2': 'tutorial_created',
        '3': 'video_demo'
    }
    
    doc_type_map = {
        '1': 'readme',
        '2': 'tutorial',
        '3': 'video'
    }
    
    action = action_map.get(choice, 'readme_update')
    doc_type = doc_type_map.get(choice, 'readme')
    
    db = GamificationDatabase()
    service = PointsService(db)
    
    result = service.award_points(
        username,
        action,
        {'doc_type': doc_type}
    )
    
    print(f"\n✅ Awarded {result['points_earned']} points to {username}!")
    print(f"   Total points: {result['total_points']}")
    if result['new_badges']:
        print(f"   🎖️  New badges: {', '.join(result['new_badges'])}")
    
    db.close()


def custom_award():
    """Award custom points."""
    username = input("\n👤 GitHub username: ").strip()
    
    print("\n🎯 Available actions:")
    db = GamificationDatabase()
    conn = db.get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT action_name, base_points, description FROM action_types ORDER BY category, base_points DESC")
    actions = cursor.fetchall()
    
    for i, action in enumerate(actions, 1):
        print(f"  {i:2d}. {action['action_name']:30s} ({action['base_points']:2d} pts) - {action['description']}")
    
    choice = input(f"\nSelect action (1-{len(actions)}): ").strip()
    
    try:
        selected_action = actions[int(choice) - 1]['action_name']
        
        service = PointsService(db)
        result = service.award_points(username, selected_action, {})
        
        print(f"\n✅ Awarded {result['points_earned']} points to {username}!")
        print(f"   Total points: {result['total_points']}")
        if result['new_badges']:
            print(f"   🎖️  New badges: {', '.join(result['new_badges'])}")
    except (ValueError, IndexError):
        print("❌ Invalid selection")
    
    db.close()


def view_profile():
    """View contributor profile."""
    username = input("\n👤 GitHub username: ").strip()
    
    db = GamificationDatabase()
    contributor = db.get_contributor_by_username(username)
    
    if not contributor:
        print(f"❌ Contributor '{username}' not found")
        db.close()
        return
    
    print(f"\n{'='*60}")
    print(f"  Profile: {username}")
    print(f"{'='*60}")
    print(f"  💰 Total Points: {contributor['total_points']}")
    print(f"  🔥 Current Streak: {contributor['current_streak']} days")
    print(f"  ⭐ Longest Streak: {contributor['longest_streak']} days")
    
    badges = db.get_contributor_badges(contributor['id'])
    if badges:
        print(f"\n  🎖️  Badges ({len(badges)}):")
        for badge in badges:
            print(f"     • {badge['name']} ({badge['tier']})")
    
    contributions = db.get_contributor_contributions(contributor['id'], limit=5)
    if contributions:
        print(f"\n  📜 Recent Contributions:")
        for contrib in contributions:
            print(f"     • {contrib['description']} (+{contrib['final_points']} pts)")
    
    db.close()


def view_leaderboard():
    """View leaderboard."""
    db = GamificationDatabase()
    leaderboard = db.get_leaderboard(limit=10)
    
    print(f"\n{'='*60}")
    print(f"  🏆 Top Contributors")
    print(f"{'='*60}")
    
    medals = {0: "🥇", 1: "🥈", 2: "🥉"}
    
    for i, entry in enumerate(leaderboard):
        medal = medals.get(i, f"{i+1:2d}.")
        print(f"  {medal} {entry['github_username']:20s} {entry['total_points']:5d} pts  🔥 {entry['current_streak']:2d} days")
    
    db.close()


def main():
    """Main program loop."""
    while True:
        show_menu()
        choice = input("\n🎯 Select option (1-8): ").strip()
        
        if choice == '1':
            award_pr_points()
        elif choice == '2':
            award_issue_points()
        elif choice == '3':
            award_review_points()
        elif choice == '4':
            award_doc_points()
        elif choice == '5':
            custom_award()
        elif choice == '6':
            view_profile()
        elif choice == '7':
            view_leaderboard()
        elif choice == '8':
            print("\n👋 Goodbye!\n")
            break
        else:
            print("\n❌ Invalid option. Please try again.")
        
        input("\n⏎ Press Enter to continue...")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n👋 Goodbye!\n")
        sys.exit(0)
