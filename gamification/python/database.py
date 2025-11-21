# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Database module for gamification system.
Handles all database operations for contributors, contributions, and badges.
"""

import sqlite3
import json
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
from pathlib import Path


class GamificationDatabase:
    """Database handler for the gamification system."""
    
    def __init__(self, db_path: str = "gamification.db"):
        """Initialize database connection."""
        self.db_path = db_path
        self.connection = None
        self._initialize_database()
    
    def _initialize_database(self):
        """Initialize database with schema if not exists."""
        schema_path = Path(__file__).parent.parent / "database" / "schema.sql"
        
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            with open(schema_path, 'r') as f:
                conn.executescript(f.read())
    
    def get_connection(self) -> sqlite3.Connection:
        """Get database connection."""
        if self.connection is None:
            self.connection = sqlite3.connect(self.db_path)
            self.connection.row_factory = sqlite3.Row
        return self.connection
    
    def close(self):
        """Close database connection."""
        if self.connection:
            self.connection.close()
            self.connection = None
    
    # Contributor methods
    def get_or_create_contributor(self, github_username: str) -> Dict[str, Any]:
        """Get existing contributor or create new one."""
        conn = self.get_connection()
        cursor = conn.cursor()
        
        # Try to get existing contributor
        cursor.execute(
            "SELECT * FROM contributors WHERE github_username = ?",
            (github_username,)
        )
        row = cursor.fetchone()
        
        if row:
            return dict(row)
        
        # Create new contributor
        cursor.execute(
            """INSERT INTO contributors (github_username, first_contribution_date)
               VALUES (?, ?)""",
            (github_username, datetime.now())
        )
        conn.commit()
        
        return self.get_or_create_contributor(github_username)
    
    def update_contributor_points(self, contributor_id: int, points_to_add: int):
        """Update contributor's total points."""
        conn = self.get_connection()
        cursor = conn.cursor()
        
        cursor.execute(
            """UPDATE contributors 
               SET total_points = total_points + ?,
                   updated_at = ?
               WHERE id = ?""",
            (points_to_add, datetime.now(), contributor_id)
        )
        conn.commit()
    
    def update_contributor_streak(self, contributor_id: int):
        """Update contributor's streak based on contribution dates."""
        conn = self.get_connection()
        cursor = conn.cursor()
        
        # Get contributor's last contribution date
        cursor.execute(
            "SELECT last_contribution_date, current_streak FROM contributors WHERE id = ?",
            (contributor_id,)
        )
        row = cursor.fetchone()
        
        if not row:
            return
        
        last_date = row['last_contribution_date']
        current_streak = row['current_streak'] or 0
        today = datetime.now().date()
        
        # Calculate new streak
        if last_date:
            last_date = datetime.fromisoformat(last_date).date()
            days_diff = (today - last_date).days
            
            if days_diff == 1:
                # Consecutive day
                new_streak = current_streak + 1
            elif days_diff == 0:
                # Same day
                new_streak = current_streak
            else:
                # Streak broken
                new_streak = 1
        else:
            new_streak = 1
        
        # Update database
        cursor.execute(
            """UPDATE contributors 
               SET current_streak = ?,
                   longest_streak = MAX(longest_streak, ?),
                   last_contribution_date = ?,
                   is_first_timer = FALSE
               WHERE id = ?""",
            (new_streak, new_streak, today, contributor_id)
        )
        conn.commit()
    
    def get_contributor_by_username(self, github_username: str) -> Optional[Dict[str, Any]]:
        """Get contributor by GitHub username."""
        conn = self.get_connection()
        cursor = conn.cursor()
        
        cursor.execute(
            "SELECT * FROM contributors WHERE github_username = ?",
            (github_username,)
        )
        row = cursor.fetchone()
        
        return dict(row) if row else None
    
    def get_leaderboard(self, limit: int = 10) -> List[Dict[str, Any]]:
        """Get top contributors by points."""
        conn = self.get_connection()
        cursor = conn.cursor()
        
        cursor.execute(
            """SELECT c.*, COUNT(cb.badge_id) as badge_count
               FROM contributors c
               LEFT JOIN contributor_badges cb ON c.id = cb.contributor_id
               GROUP BY c.id
               ORDER BY c.total_points DESC
               LIMIT ?""",
            (limit,)
        )
        
        return [dict(row) for row in cursor.fetchall()]
    
    # Contribution methods
    def add_contribution(self, contributor_id: int, action_type: str, 
                        points: int, multiplier: float = 1.0, 
                        metadata: Optional[Dict] = None) -> int:
        """Add a new contribution record."""
        conn = self.get_connection()
        cursor = conn.cursor()
        
        final_points = int(points * multiplier)
        
        cursor.execute(
            """INSERT INTO contributions 
               (contributor_id, action_type, points_earned, multiplier, 
                final_points, metadata)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (contributor_id, action_type, points, multiplier, 
             final_points, json.dumps(metadata) if metadata else None)
        )
        conn.commit()
        
        # Update contributor points and streak
        self.update_contributor_points(contributor_id, final_points)
        self.update_contributor_streak(contributor_id)
        
        return cursor.lastrowid
    
    def get_contributor_contributions(self, contributor_id: int, 
                                     limit: Optional[int] = None) -> List[Dict[str, Any]]:
        """Get contributions for a contributor."""
        conn = self.get_connection()
        cursor = conn.cursor()
        
        query = """SELECT c.*, at.description, at.category
                   FROM contributions c
                   LEFT JOIN action_types at ON c.action_type = at.action_name
                   WHERE c.contributor_id = ?
                   ORDER BY c.contribution_date DESC"""
        
        if limit:
            query += f" LIMIT {limit}"
        
        cursor.execute(query, (contributor_id,))
        
        return [dict(row) for row in cursor.fetchall()]
    
    # Badge methods
    def get_all_badges(self) -> List[Dict[str, Any]]:
        """Get all available badges."""
        conn = self.get_connection()
        cursor = conn.cursor()
        
        cursor.execute("SELECT * FROM badges ORDER BY tier, points_required")
        
        return [dict(row) for row in cursor.fetchall()]
    
    def get_contributor_badges(self, contributor_id: int) -> List[Dict[str, Any]]:
        """Get badges earned by contributor."""
        conn = self.get_connection()
        cursor = conn.cursor()
        
        cursor.execute(
            """SELECT b.*, cb.awarded_date
               FROM contributor_badges cb
               JOIN badges b ON cb.badge_id = b.id
               WHERE cb.contributor_id = ?
               ORDER BY cb.awarded_date DESC""",
            (contributor_id,)
        )
        
        return [dict(row) for row in cursor.fetchall()]
    
    def award_badge(self, contributor_id: int, badge_id: int) -> bool:
        """Award a badge to a contributor."""
        conn = self.get_connection()
        cursor = conn.cursor()
        
        try:
            cursor.execute(
                """INSERT INTO contributor_badges (contributor_id, badge_id)
                   VALUES (?, ?)""",
                (contributor_id, badge_id)
            )
            conn.commit()
            return True
        except sqlite3.IntegrityError:
            # Badge already awarded
            return False
    
    def check_and_award_badges(self, contributor_id: int) -> List[Dict[str, Any]]:
        """Check and award any new badges for contributor."""
        conn = self.get_connection()
        cursor = conn.cursor()
        
        # Get contributor data
        cursor.execute("SELECT * FROM contributors WHERE id = ?", (contributor_id,))
        contributor = dict(cursor.fetchone())
        
        # Get contributions by category
        cursor.execute(
            """SELECT at.category, COUNT(*) as count, SUM(c.final_points) as points
               FROM contributions c
               JOIN action_types at ON c.action_type = at.action_name
               WHERE c.contributor_id = ?
               GROUP BY at.category""",
            (contributor_id,)
        )
        category_stats = {row['category']: dict(row) for row in cursor.fetchall()}
        
        # Get all badges
        badges = self.get_all_badges()
        newly_awarded = []
        
        for badge in badges:
            # Check if already awarded
            cursor.execute(
                "SELECT id FROM contributor_badges WHERE contributor_id = ? AND badge_id = ?",
                (contributor_id, badge['id'])
            )
            if cursor.fetchone():
                continue
            
            # Check criteria
            criteria = json.loads(badge['criteria']) if badge['criteria'] else {}
            
            if self._check_badge_criteria(contributor, category_stats, criteria):
                if self.award_badge(contributor_id, badge['id']):
                    newly_awarded.append(badge)
        
        return newly_awarded
    
    def _check_badge_criteria(self, contributor: Dict, category_stats: Dict, 
                              criteria: Dict) -> bool:
        """Check if contributor meets badge criteria."""
        # Points-based criteria
        if 'min_points' in criteria:
            if contributor['total_points'] < criteria['min_points']:
                return False
        
        # Streak-based criteria
        if 'min_streak' in criteria:
            if contributor['current_streak'] < criteria['min_streak']:
                return False
        
        # First contribution
        if criteria.get('is_first_contribution'):
            if not contributor['is_first_timer']:
                return False
        
        # Category-based criteria
        if 'category' in criteria:
            cat = criteria['category']
            if cat not in category_stats:
                return False
            if 'min_points' in criteria:
                if category_stats[cat]['points'] < criteria['min_points']:
                    return False
        
        # Action count criteria
        if 'action' in criteria and 'count' in criteria:
            conn = self.get_connection()
            cursor = conn.cursor()
            cursor.execute(
                "SELECT COUNT(*) as count FROM contributions WHERE contributor_id = ? AND action_type = ?",
                (contributor['id'], criteria['action'])
            )
            if cursor.fetchone()['count'] < criteria['count']:
                return False
        
        return True
    
    # Action types
    def get_action_points(self, action_name: str) -> int:
        """Get base points for an action type."""
        conn = self.get_connection()
        cursor = conn.cursor()
        
        cursor.execute(
            "SELECT base_points FROM action_types WHERE action_name = ?",
            (action_name,)
        )
        row = cursor.fetchone()
        
        return row['base_points'] if row else 0
