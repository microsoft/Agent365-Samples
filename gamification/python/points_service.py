# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Points calculation service for gamification system.
Handles all logic for calculating points with multipliers, bonuses, and streaks.
"""

from datetime import datetime, timedelta
from typing import Dict, Optional, Tuple
from enum import Enum


class Priority(Enum):
    """Issue/PR priority levels."""
    LOW = 1.0
    MEDIUM = 1.0
    HIGH = 2.0
    CRITICAL = 3.0


class PointsCalculator:
    """Calculate points for contributions with multipliers and bonuses."""
    
    # Bonus percentages
    SPEED_BONUS_PERCENTAGE = 0.20  # 20% bonus
    STREAK_BONUS_POINTS = 10  # Flat 10 points
    FIRST_TIMER_BONUS = 5  # Flat 5 points
    
    # Thresholds
    SPEED_BONUS_HOURS = 24
    STREAK_BONUS_DAYS = 5
    
    def __init__(self, base_points: int):
        """Initialize calculator with base points for action."""
        self.base_points = base_points
        self.multiplier = 1.0
        self.bonuses = []
    
    def apply_priority_multiplier(self, priority: Priority) -> 'PointsCalculator':
        """Apply priority multiplier to points."""
        self.multiplier *= priority.value
        if priority in [Priority.HIGH, Priority.CRITICAL]:
            self.bonuses.append(f"{priority.name} Priority (×{priority.value})")
        return self
    
    def apply_speed_bonus(self, created_at: datetime, completed_at: Optional[datetime] = None) -> 'PointsCalculator':
        """Apply speed bonus if completed within threshold."""
        if completed_at is None:
            completed_at = datetime.now()
        
        time_delta = completed_at - created_at
        hours_taken = time_delta.total_seconds() / 3600
        
        if hours_taken <= self.SPEED_BONUS_HOURS:
            self.multiplier *= (1 + self.SPEED_BONUS_PERCENTAGE)
            self.bonuses.append(f"Speed Bonus (+{int(self.SPEED_BONUS_PERCENTAGE * 100)}%)")
        
        return self
    
    def apply_streak_bonus(self, current_streak: int) -> 'PointsCalculator':
        """Apply streak bonus if streak threshold met."""
        if current_streak > 0 and current_streak % self.STREAK_BONUS_DAYS == 0:
            # Add flat bonus points after multiplier
            self.bonuses.append(f"Streak Bonus (+{self.STREAK_BONUS_POINTS} points)")
        
        return self
    
    def apply_first_timer_bonus(self, is_first_timer: bool) -> 'PointsCalculator':
        """Apply first-timer bonus."""
        if is_first_timer:
            self.bonuses.append(f"First Timer Bonus (+{self.FIRST_TIMER_BONUS} points)")
        
        return self
    
    def calculate(self, current_streak: int = 0, is_first_timer: bool = False) -> Tuple[int, float, str]:
        """
        Calculate final points with all multipliers and bonuses.
        
        Returns:
            Tuple of (final_points, total_multiplier, bonus_description)
        """
        # Calculate base points with multiplier
        points_with_multiplier = int(self.base_points * self.multiplier)
        
        # Add flat bonuses
        flat_bonuses = 0
        
        # Streak bonus
        if current_streak > 0 and current_streak % self.STREAK_BONUS_DAYS == 0:
            flat_bonuses += self.STREAK_BONUS_POINTS
        
        # First timer bonus
        if is_first_timer:
            flat_bonuses += self.FIRST_TIMER_BONUS
        
        final_points = points_with_multiplier + flat_bonuses
        bonus_description = " | ".join(self.bonuses) if self.bonuses else "No bonuses"
        
        return final_points, self.multiplier, bonus_description


class PointsService:
    """Service for calculating points for different contribution actions."""
    
    def __init__(self, database):
        """Initialize with database connection."""
        self.db = database
    
    def calculate_pr_merged_points(self, github_username: str, pr_data: Dict) -> Tuple[int, float, Dict]:
        """
        Calculate points for merged PR.
        
        Args:
            github_username: GitHub username of contributor
            pr_data: Dictionary containing PR information
                - created_at: When PR was created
                - merged_at: When PR was merged
                - priority: PR priority (optional)
                - is_bug_fix: Whether this fixes a bug (optional)
        
        Returns:
            Tuple of (points, multiplier, metadata)
        """
        contributor = self.db.get_or_create_contributor(github_username)
        
        # Determine base action and points
        action = 'pr_merged'
        base_points = self.db.get_action_points(action)
        
        # Check if this is a bug fix (higher points)
        if pr_data.get('is_bug_fix'):
            action = 'bug_fixed'
            base_points = self.db.get_action_points('bug_fixed')
        
        calculator = PointsCalculator(base_points)
        
        # Apply priority multiplier
        priority = Priority[pr_data.get('priority', 'MEDIUM').upper()]
        calculator.apply_priority_multiplier(priority)
        
        # Apply speed bonus
        created_at = pr_data.get('created_at')
        merged_at = pr_data.get('merged_at')
        if created_at and merged_at:
            calculator.apply_speed_bonus(created_at, merged_at)
        
        # Apply streak and first-timer bonuses
        calculator.apply_streak_bonus(contributor['current_streak'])
        calculator.apply_first_timer_bonus(contributor['is_first_timer'])
        
        final_points, multiplier, bonus_desc = calculator.calculate(
            contributor['current_streak'],
            contributor['is_first_timer']
        )
        
        metadata = {
            'pr_number': pr_data.get('pr_number'),
            'pr_title': pr_data.get('pr_title'),
            'priority': priority.name,
            'bonuses': bonus_desc,
            'is_bug_fix': pr_data.get('is_bug_fix', False)
        }
        
        return final_points, multiplier, metadata
    
    def calculate_code_review_points(self, github_username: str, review_data: Dict) -> Tuple[int, float, Dict]:
        """
        Calculate points for code review.
        
        Args:
            github_username: GitHub username of reviewer
            review_data: Dictionary containing review information
                - review_type: 'basic' or 'detailed'
                - has_performance_suggestion: Boolean
                - is_approval: Boolean
        
        Returns:
            Tuple of (points, multiplier, metadata)
        """
        contributor = self.db.get_or_create_contributor(github_username)
        
        # Determine review type
        review_type = review_data.get('review_type', 'basic')
        
        if review_type == 'detailed':
            action = 'review_detailed'
        elif review_data.get('has_performance_suggestion'):
            action = 'review_performance_suggestion'
        elif review_data.get('is_approval'):
            action = 'review_approve'
        else:
            action = 'review_basic'
        
        base_points = self.db.get_action_points(action)
        calculator = PointsCalculator(base_points)
        
        # Apply bonuses
        calculator.apply_streak_bonus(contributor['current_streak'])
        calculator.apply_first_timer_bonus(contributor['is_first_timer'])
        
        final_points, multiplier, bonus_desc = calculator.calculate(
            contributor['current_streak'],
            contributor['is_first_timer']
        )
        
        metadata = {
            'pr_number': review_data.get('pr_number'),
            'review_type': action,
            'bonuses': bonus_desc
        }
        
        return final_points, multiplier, metadata
    
    def calculate_issue_points(self, github_username: str, issue_data: Dict) -> Tuple[int, float, Dict]:
        """
        Calculate points for closing an issue.
        
        Args:
            github_username: GitHub username
            issue_data: Dictionary containing issue information
                - created_at: When issue was created
                - closed_at: When issue was closed
                - priority: Issue priority
                - is_security: Whether it's a security issue
        
        Returns:
            Tuple of (points, multiplier, metadata)
        """
        contributor = self.db.get_or_create_contributor(github_username)
        
        # Determine action type
        if issue_data.get('is_security'):
            action = 'security_fix'
        else:
            action = 'issue_closed'
        
        base_points = self.db.get_action_points(action)
        calculator = PointsCalculator(base_points)
        
        # Apply priority multiplier
        priority = Priority[issue_data.get('priority', 'MEDIUM').upper()]
        calculator.apply_priority_multiplier(priority)
        
        # Apply speed bonus
        created_at = issue_data.get('created_at')
        closed_at = issue_data.get('closed_at')
        if created_at and closed_at:
            calculator.apply_speed_bonus(created_at, closed_at)
        
        # Apply bonuses
        calculator.apply_streak_bonus(contributor['current_streak'])
        calculator.apply_first_timer_bonus(contributor['is_first_timer'])
        
        final_points, multiplier, bonus_desc = calculator.calculate(
            contributor['current_streak'],
            contributor['is_first_timer']
        )
        
        metadata = {
            'issue_number': issue_data.get('issue_number'),
            'issue_title': issue_data.get('issue_title'),
            'priority': priority.name,
            'bonuses': bonus_desc,
            'is_security': issue_data.get('is_security', False)
        }
        
        return final_points, multiplier, metadata
    
    def calculate_documentation_points(self, github_username: str, doc_data: Dict) -> Tuple[int, float, Dict]:
        """
        Calculate points for documentation contributions.
        
        Args:
            github_username: GitHub username
            doc_data: Dictionary containing documentation information
                - doc_type: 'readme', 'tutorial', 'video'
        
        Returns:
            Tuple of (points, multiplier, metadata)
        """
        contributor = self.db.get_or_create_contributor(github_username)
        
        doc_type = doc_data.get('doc_type', 'readme')
        action_map = {
            'readme': 'readme_update',
            'tutorial': 'tutorial_created',
            'video': 'video_demo'
        }
        
        action = action_map.get(doc_type, 'readme_update')
        base_points = self.db.get_action_points(action)
        
        calculator = PointsCalculator(base_points)
        calculator.apply_streak_bonus(contributor['current_streak'])
        calculator.apply_first_timer_bonus(contributor['is_first_timer'])
        
        final_points, multiplier, bonus_desc = calculator.calculate(
            contributor['current_streak'],
            contributor['is_first_timer']
        )
        
        metadata = {
            'doc_type': doc_type,
            'bonuses': bonus_desc
        }
        
        return final_points, multiplier, metadata
    
    def award_points(self, github_username: str, action_type: str, 
                    action_data: Dict) -> Dict:
        """
        Award points for any action.
        
        Args:
            github_username: GitHub username
            action_type: Type of action ('pr_merged', 'code_review', etc.)
            action_data: Action-specific data
        
        Returns:
            Dictionary with contribution details
        """
        contributor = self.db.get_or_create_contributor(github_username)
        
        # Calculate points based on action type
        if action_type in ['pr_merged', 'pr_created']:
            points, multiplier, metadata = self.calculate_pr_merged_points(
                github_username, action_data
            )
        elif action_type.startswith('review_'):
            points, multiplier, metadata = self.calculate_code_review_points(
                github_username, action_data
            )
        elif action_type in ['issue_closed', 'security_fix']:
            points, multiplier, metadata = self.calculate_issue_points(
                github_username, action_data
            )
        elif action_type in ['readme_update', 'tutorial_created', 'video_demo']:
            points, multiplier, metadata = self.calculate_documentation_points(
                github_username, action_data
            )
        else:
            # Generic action
            base_points = self.db.get_action_points(action_type)
            calculator = PointsCalculator(base_points)
            calculator.apply_streak_bonus(contributor['current_streak'])
            calculator.apply_first_timer_bonus(contributor['is_first_timer'])
            points, multiplier, bonus_desc = calculator.calculate(
                contributor['current_streak'],
                contributor['is_first_timer']
            )
            metadata = {'bonuses': bonus_desc}
        
        # Add contribution to database
        contribution_id = self.db.add_contribution(
            contributor['id'],
            action_type,
            int(points / multiplier) if multiplier > 0 else points,
            multiplier,
            metadata
        )
        
        # Check for new badges
        new_badges = self.db.check_and_award_badges(contributor['id'])
        
        # Get updated contributor data
        updated_contributor = self.db.get_contributor_by_username(github_username)
        
        return {
            'contribution_id': contribution_id,
            'points_earned': points,
            'total_points': updated_contributor['total_points'],
            'current_streak': updated_contributor['current_streak'],
            'new_badges': [badge['name'] for badge in new_badges],
            'metadata': metadata
        }
