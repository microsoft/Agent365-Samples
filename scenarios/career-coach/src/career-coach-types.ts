// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Career Coach data types
// These types define the structure of data in SharePoint Lists
// accessed via Microsoft Graph (agentic delegated auth)
// --- Reference Data (read-only) ---

export interface CompetencyFrameworkRow {
  Title: string;
  RoleId: string;
  RoleTitle: string;
  RoleLevel: string;
  CompetencyId: string;
  CompetencyName: string;
  RequiredLevel: number;
  LevelDescription: string;
  Category: string;
}

export interface LearningCatalogRow {
  Title: string;
  CourseId: string;
  Provider: string;
  Format: string;
  SkillIds: string; // semicolon-separated competency IDs
  FromLevel: number;
  ToLevel: number;
  URL: string;
  Description: string;
  ResourceType: string;
}

// --- User State (read/write, JSON columns) ---

export interface UserGoal {
  goalId: string;
  competencyId: string;
  competencyName: string;
  targetDate?: string;
  status: 'Not Started' | 'In Progress' | 'Complete';
  progressPct: number;
  notes?: string;
  createdDate: string;
}

export interface UserSkill {
  competencyId: string;
  competencyName: string;
  currentLevel: number;
  targetLevel: number;
  gap: number;
  gapCategory: 'Strong' | 'Growing' | 'To Build';
  source: 'Self-reported' | 'Course completion';
  lastUpdated: string;
  evidence?: string;
}

// Latest-only inline quiz summary stored on each LearningProgress entry.
// Full attempt history (including per-question detail) lives in the QuizResponses list.
export interface UserLearningQuizSummary {
  attemptDate: string;
  score: number;             // 0..5
  passed: boolean;           // score >= 4
  topicTagsWrong: string[];  // topic tags of wrong-answered questions
  attempts?: number;         // total attempts to date for this course
}

export interface UserLearningRecord {
  courseId: string;
  courseTitle: string;
  skillId: string;
  status: 'Recommended' | 'In Progress' | 'Complete';
  recommendedDate: string;
  completedDate?: string;
  url: string;
  // Progress-sync fields (populated when we mirror a learning portal row).
  percentComplete?: number;
  timeSpentMinutes?: number;
  // Latest quiz summary for this course; full log lives in the QuizResponses list.
  quizResult?: UserLearningQuizSummary;
}

export interface UserState {
  Title: string;
  UserAADId: string;
  CurrentRole: string;
  CurrentLevel: string;
  TargetRole: string;
  TargetRoleId: string;
  TotalExperience: string;
  OverallProgress: number;
  Goals: UserGoal[];
  Skills: UserSkill[];
  LearningProgress: UserLearningRecord[];
  ManagerAsks: string;
  PlanCreatedDate: string;
  LastCheckIn: string;
  // Manager (populated once via Graph /me/manager, cached for 100% completion email).
  ManagerName?: string;
  ManagerEmail?: string;
  // Sync + one-shot milestone guards.
  LastSyncDate?: string;
  Milestone80Fired?: boolean;
  Completion100Fired?: boolean;
  // Goal lifecycle — one UserState row per goal; only the Active one is worked on.
  PlanStatus?: PlanStatus;
  PlanCompletedDate?: string;
}

/**
 * Active = the goal being worked on (at most one per user). Completed = reached 100% and
 * the completion email went out. Replaced = the user saved a new goal before finishing this one.
 */
export type PlanStatus = 'Active' | 'Completed' | 'Replaced';

/** App-managed lifecycle columns — never written by the LLM. */
export const PLAN_LIFECYCLE_FIELDS = ['PlanStatus', 'PlanCompletedDate', 'Completion100Fired'] as const;

/**
 * UserState columns the LLM can never write: the lifecycle columns plus the manager's identity. The
 * completion email is addressed to ManagerEmail, so it is populated only by the app from the directory
 * (`/users/{id}/manager`) — a model write could otherwise redirect the report to any address.
 */
export const APP_MANAGED_USERSTATE_FIELDS = [...PLAN_LIFECYCLE_FIELDS, 'ManagerName', 'ManagerEmail'] as const;

/**
 * Status of a UserState row (display-name fields). Rows saved before the lifecycle columns
 * existed have no PlanStatus: they count as Completed once Completion100Fired is set.
 */
export function planStatusOf(fields: Record<string, any> | null | undefined): PlanStatus {
  const raw = String(fields?.PlanStatus ?? '').trim().toLowerCase();
  if (raw === 'completed') return 'Completed';
  if (raw === 'replaced') return 'Replaced';
  if (raw === 'active') return 'Active';
  const fired = fields?.Completion100Fired;
  const done = fired === true || ['true', 'yes', '1'].includes(String(fired ?? '').toLowerCase());
  return done ? 'Completed' : 'Active';
}

// --- LearningPortalStatus (mimic'd learning-portal source, populated in the backend) ---
export interface LearningPortalStatusRow {
  Title: string;
  UserAADId: string;
  CourseId: string;
  Status: 'Not Started' | 'In Progress' | 'Complete';
  PercentComplete: number;      // 0..100
  TimeSpentMinutes: number;
  CompletedDate?: string;
  LastUpdated: string;
}

// --- QuizResponses (one row per quiz attempt) ---
export interface QuizResponseRow {
  Title: string;
  UserAADId: string;
  CourseId: string;
  SkillId: string;
  AttemptDate: string;
  Score: number;                // 0..5
  Passed: boolean;
  QuestionsJSON: string;        // JSON string: array of { id, type, text, choices?, correctAnswer, userAnswer, correct, topicTag }
}

// --- SharePoint Configuration ---

export const SP_CONFIG = {
  siteHost: process.env.SP_SITE_HOST || 'contoso.sharepoint.com',
  sitePath: process.env.SP_SITE_PATH || '/sites/CareerCoach',
  lists: {
    competencyFramework: process.env.SP_LIST_COMPETENCY_FRAMEWORK || 'CompetencyFramework_v2',
    learningCatalog: process.env.SP_LIST_LEARNING_CATALOG || 'LearningCatalog_v2',
    userState: process.env.SP_LIST_USER_STATE || 'UserState',
    learningPortalStatus: process.env.SP_LIST_LEARNING_PORTAL_STATUS || 'LearningPortalStatus',
    quizResponses: process.env.SP_LIST_QUIZ_RESPONSES || 'QuizResponses',
  },
  get siteUrl() {
    return `https://${this.siteHost}${this.sitePath}`;
  }
};
