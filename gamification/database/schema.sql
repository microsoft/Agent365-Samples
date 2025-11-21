-- Copyright (c) Microsoft Corporation.
-- Licensed under the MIT License.

-- Contributors Profile Table
CREATE TABLE IF NOT EXISTS contributors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    github_username VARCHAR(255) UNIQUE NOT NULL,
    total_points INTEGER DEFAULT 0,
    current_streak INTEGER DEFAULT 0,
    longest_streak INTEGER DEFAULT 0,
    last_contribution_date DATE,
    first_contribution_date DATE,
    is_first_timer BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Contribution Actions Table
CREATE TABLE IF NOT EXISTS contributions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contributor_id INTEGER NOT NULL,
    action_type VARCHAR(100) NOT NULL,
    points_earned INTEGER NOT NULL,
    multiplier DECIMAL(3,2) DEFAULT 1.0,
    final_points INTEGER NOT NULL,
    metadata TEXT, -- JSON string with additional info (PR number, issue number, etc.)
    contribution_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contributor_id) REFERENCES contributors(id) ON DELETE CASCADE
);

-- Badges Table
CREATE TABLE IF NOT EXISTS badges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    tier VARCHAR(50) NOT NULL, -- Bronze, Silver, Gold, Platinum, Special
    points_required INTEGER,
    icon_url VARCHAR(500),
    criteria TEXT, -- JSON string with badge-specific criteria
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Contributor Badges Table (Many-to-Many)
CREATE TABLE IF NOT EXISTS contributor_badges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contributor_id INTEGER NOT NULL,
    badge_id INTEGER NOT NULL,
    awarded_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contributor_id) REFERENCES contributors(id) ON DELETE CASCADE,
    FOREIGN KEY (badge_id) REFERENCES badges(id) ON DELETE CASCADE,
    UNIQUE(contributor_id, badge_id)
);

-- Action Types Reference Table
CREATE TABLE IF NOT EXISTS action_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_name VARCHAR(100) UNIQUE NOT NULL,
    base_points INTEGER NOT NULL,
    description TEXT,
    category VARCHAR(50) -- Code, Review, Documentation, Community, Security, Mentorship
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_contributions_contributor_id ON contributions(contributor_id);
CREATE INDEX IF NOT EXISTS idx_contributions_action_type ON contributions(action_type);
CREATE INDEX IF NOT EXISTS idx_contributions_date ON contributions(contribution_date);
CREATE INDEX IF NOT EXISTS idx_contributors_points ON contributors(total_points DESC);
CREATE INDEX IF NOT EXISTS idx_contributors_streak ON contributors(current_streak DESC);
CREATE INDEX IF NOT EXISTS idx_contributor_badges_contributor ON contributor_badges(contributor_id);
CREATE INDEX IF NOT EXISTS idx_contributor_badges_badge ON contributor_badges(badge_id);

-- Insert default action types
INSERT OR IGNORE INTO action_types (action_name, base_points, description, category) VALUES
-- Code Contributions
('pr_merged', 5, 'Merge a Pull Request', 'Code'),
('pr_created', 3, 'Create a Pull Request', 'Code'),
('issue_closed', 2, 'Close an Issue', 'Code'),
('bug_fixed', 10, 'Fix a Bug (verified)', 'Code'),
('tests_added', 8, 'Add Unit Tests (coverage >80%)', 'Code'),
('refactor_performance', 6, 'Refactor for performance', 'Code'),

-- Code Review & Quality
('review_basic', 5, 'Basic Review', 'Review'),
('review_detailed', 10, 'Detailed Review with Comments', 'Review'),
('review_performance_suggestion', 4, 'Suggest Performance Improvement', 'Review'),
('review_approve', 3, 'Approve PR after changes', 'Review'),

-- Documentation & Community
('readme_update', 4, 'Add/Update README', 'Documentation'),
('tutorial_created', 8, 'Write Tutorial or Wiki Page', 'Documentation'),
('discussion_answer', 2, 'Answer Discussion/Issue', 'Community'),
('video_demo', 10, 'Create Video Demo', 'Documentation'),

-- Security & Compliance
('security_report', 15, 'Report Security Vulnerability', 'Security'),
('security_fix', 20, 'Fix Security Vulnerability', 'Security'),

-- Collaboration & Mentorship
('pair_programming', 5, 'Pair Programming Session', 'Mentorship'),
('mentorship', 10, 'Mentor a New Contributor', 'Mentorship');

-- Insert default badges
INSERT OR IGNORE INTO badges (name, description, tier, points_required, criteria) VALUES
-- Point-based badges
('Rookie', 'Welcome to the community! Earned your first points.', 'Bronze', 10, '{"min_points": 10}'),
('Contributor', 'Active contributor with consistent contributions.', 'Bronze', 50, '{"min_points": 50}'),
('Regular', 'Regular contributor making steady progress.', 'Silver', 100, '{"min_points": 100}'),
('Expert', 'Expert contributor with significant impact.', 'Silver', 250, '{"min_points": 250}'),
('Master', 'Master contributor - a pillar of the community.', 'Gold', 500, '{"min_points": 500}'),
('Legend', 'Legendary contributor with extraordinary contributions.', 'Gold', 1000, '{"min_points": 1000}'),
('Champion', 'Champion of the repository - ultimate achievement!', 'Platinum', 2500, '{"min_points": 2500}'),

-- Category-specific badges
('Code Warrior', 'Merged 10+ Pull Requests', 'Silver', 0, '{"action": "pr_merged", "count": 10}'),
('Review Master', 'Completed 20+ code reviews', 'Silver', 0, '{"action": "review_detailed", "count": 20}'),
('Bug Squasher', 'Fixed 5+ verified bugs', 'Gold', 0, '{"action": "bug_fixed", "count": 5}'),
('Documentation Hero', 'Created comprehensive documentation', 'Silver', 0, '{"category": "Documentation", "min_points": 50}'),
('Security Guardian', 'Reported or fixed security vulnerabilities', 'Platinum', 0, '{"category": "Security", "min_actions": 1}'),
('Mentor', 'Helped onboard new contributors', 'Gold', 0, '{"action": "mentorship", "count": 3}'),

-- Special achievement badges
('Speed Demon', 'Completed 10+ tasks within 24 hours', 'Gold', 0, '{"speed_bonus_count": 10}'),
('Streak Master', 'Maintained a 30-day contribution streak', 'Gold', 0, '{"min_streak": 30}'),
('First Timer', 'Made your first contribution!', 'Special', 0, '{"is_first_contribution": true}'),
('All Rounder', 'Contributed across all categories', 'Platinum', 0, '{"unique_categories": 5}');
