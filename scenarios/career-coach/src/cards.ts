// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Deterministic Adaptive Card rendering for the Career Coach.
//
// The LLM stays grounded in SharePoint data (it fills the card DATA from tool
// results), while these builders own the VISUAL rendering. The model emits a
// fenced ```card block containing one JSON payload; `extractCards` pulls it out
// and the matching builder turns it into an Adaptive Card attachment. If a
// payload is missing/invalid we fall back to plain text, so a bad block never
// blocks the user.

import { Attachment } from '@microsoft/agents-activity';
import { CardFactory } from '@microsoft/agents-hosting';

const GRAD_ICON = 'https://cdn-icons-png.flaticon.com/128/3135/3135755.png';

type Status = 'Strong' | 'Growing' | 'To Build';

export type CardPayload =
  | { type: 'welcome'; greeting: string; tagline?: string; capabilities?: { icon: string; title: string; desc: string }[]; prompt: string }
  | { type: 'skillPath'; roleTitle: string; intro?: string; skills: SkillPathSkill[]; footer?: string; interactive?: boolean; readOnly?: boolean }
  | { type: 'gapAnalysis'; roleTitle: string; skills: { name: string; target: number; current: number; gap: number; status: Status }[]; goals?: string[]; footer?: string }
  | { type: 'planReview'; roleTitle: string; intro?: string; skills: PlanReviewSkill[]; totalCourses?: number; footer?: string }
  | { type: 'courses'; intro?: string; groups: { skill: string; courses: { title: string; provider?: string; format?: string; url?: string }[] }[]; footer?: string }
  | { type: 'progress'; roleTitle?: string; overall?: number; goals: { name: string; progressPct: number; status?: string }[]; learning?: { title: string; skill?: string; status?: string }[]; footer?: string }
  | { type: 'roadmap'; roleTitle: string; stages: { label: string; detail?: string; state?: 'done' | 'current' | 'todo' }[]; footer?: string }
  | { type: 'prepBrief'; roleTitle?: string; overall?: number; goals?: { name: string; progressPct: number; status?: string }[]; managerAsks?: string; wins: { title: string; star: string }[]; talkingPoints: string[]; questions: string[]; footer?: string }
  | { type: 'quiz'; courseId: string; courseTitle: string; skillId?: string; skillName?: string; intro?: string; questions: QuizQuestion[]; footer?: string }
  | { type: 'quizResult'; courseTitle: string; skillName?: string; score: number; total: number; passed: boolean; feedback: QuizFeedback[]; footer?: string }
  | { type: 'milestone80'; roleTitle?: string; overall: number; stillToClose: { name: string; progressPct: number }[]; areasToStrengthen: string[]; footer?: string }
  | { type: 'completionSummary'; roleTitle?: string; managerName?: string; managerEmail?: string; userEmail?: string; totalTimeMinutes?: number; coursesCompleted?: number; subject?: string; sent: boolean; note?: string; footer?: string };

// A single quiz question. The LLM emits these; the builder renders them; the
// LLM also keeps the same payload in its own history so it can grade the
// submitted answers without any extra plumbing.
export interface QuizQuestion {
  id: string;                // e.g. "q1"..."q5"
  type: 'mcq' | 'short';
  text: string;
  choices?: string[];        // required when type === 'mcq'
  topicTag: string;          // short lowercase-hyphenated topic label (e.g. "prompt-injection")
}

export interface QuizFeedback {
  id: string;
  text: string;              // the question text
  userAnswer: string;        // what the user submitted (or "(no answer)")
  correct: boolean;
  correctAnswer: string;
  topicTag: string;
  explanation?: string;      // optional 1-line grading rationale (short-answer only)
}

// A row in the interactive skillPath card. Each skill renders a 0-4 radio input for
// self-assessment. Course previews live in the planReview card (Stage 2), not here.
export interface SkillPathSkill {
  id: string;                // e.g. "skill-1"; also used as the Input.ChoiceSet id
  name: string;
  target: number;
  description?: string;
  competencyId?: string;     // handed back to the LLM in the submit payload
  currentLevel?: number;     // populated in the read-only variant (post-submit)
}

// A row in the combined gap-analysis + recommended-courses card (Stage 2 output).
// One row per skill in the target role. Skills already at or above target have gap=0
// and no courses; they're kept in the card for a complete "your plan" picture.
export interface PlanReviewSkill {
  competencyId?: string;
  name: string;
  target: number;
  current: number;
  gap: number;
  status: Status;
  courses?: {
    courseId?: string;
    title: string;
    url?: string;
    provider?: string;
    format?: string;
    fromLevel?: number;
    toLevel?: number;
  }[];
}

const AC = (body: any[], actions: any[] = []) => ({
  $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
  type: 'AdaptiveCard',
  version: '1.5',
  // Teams-specific: render the card at the full width of the conversation pane
  // instead of the default narrower column.
  msteams: { width: 'Full' },
  body,
  ...(actions.length ? { actions } : {}),
});

const header = (text: string) => ({ type: 'TextBlock', text, weight: 'Bolder', size: 'Large', wrap: true });
const sub = (text: string) => ({ type: 'TextBlock', text, wrap: true, isSubtle: true, spacing: 'Small' });
const th = (text: string) => ({ type: 'TableCell', items: [{ type: 'TextBlock', text, weight: 'Bolder', wrap: true }] });
const td = (text: string, color?: string) => ({ type: 'TableCell', items: [{ type: 'TextBlock', text: String(text), wrap: true, ...(color ? { color } : {}) }] });

const statusColor = (s: Status): string => (s === 'Strong' ? 'Good' : s === 'Growing' ? 'Warning' : 'Attention');
const statusDot = (s: Status): string => (s === 'Strong' ? '🟢' : s === 'Growing' ? '🟡' : '🔴');

function progressBar(pct: number): string {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const filled = Math.round(clamped / 10);
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled) + `  ${clamped}%`;
}

// Prefer computing overall from the per-goal progress so the headline bar can never
// disagree with the goal rows. Falls back to the model-supplied value only when no goals exist.
function deriveOverall(goals?: { progressPct: number }[], fallback?: number): number | undefined {
  if (goals && goals.length) {
    const sum = goals.reduce((acc, g) => acc + (Number(g.progressPct) || 0), 0);
    return Math.round(sum / goals.length);
  }
  return typeof fallback === 'number' ? fallback : undefined;
}

function table(columns: number[], rows: any[]) {
  return { type: 'Table', columns: columns.map((w) => ({ width: w })), firstRowAsHeaders: true, rows };
}
const row = (cells: any[]) => ({ type: 'TableRow', cells });

const DEFAULT_CAPABILITIES = [
  { icon: '🎯', title: 'Set your goal', desc: 'Pick a target role and build a development plan' },
  { icon: '📊', title: 'Map your skills', desc: 'See your strengths and the gaps to close' },
  { icon: '📚', title: 'Get course picks', desc: 'Real learning matched to each of your gaps' },
  { icon: '🚀', title: 'Track your progress', desc: 'Update your plan as you learn and grow' },
  { icon: '🎤', title: 'Prep for 1:1s', desc: 'Turn your wins into confident talking points' },
];

function buildWelcome(p: Extract<CardPayload, { type: 'welcome' }>) {
  // Compact 2×2 tile-grid welcome. Each tile is a tappable Container (via selectAction)
  // that fires an Action.Execute with verb "careercoach_welcome" and { intent } payload —
  // the handler in agent.ts maps each intent to the corresponding flow (goal-setting,
  // skills, prep, progress).
  //
  // NOTE: We use Action.Execute (not Action.Submit) because the A365 SDK reserves
  // activity.value.action for internal use — a plain Action.Submit with data.action
  // triggers a "Expected object, received string" validation error inside the SDK.
  //
  // The old capabilities list from `p.capabilities` is intentionally ignored — this
  // design ships a fixed 4-tile menu regardless of what the caller passes.
  const tile = (icon: string, title: string, desc: string, intent: string) => ({
    type: 'Container',
    style: 'emphasis',
    spacing: 'Small',
    selectAction: {
      type: 'Action.Execute',
      verb: 'careercoach_welcome',
      data: { intent },
    },
    items: [
      { type: 'TextBlock', text: `${icon} ${title}`, weight: 'Bolder', horizontalAlignment: 'Center' },
      { type: 'TextBlock', text: desc, size: 'Small', isSubtle: true, horizontalAlignment: 'Center', spacing: 'None', wrap: true },
    ],
  });

  const body: any[] = [
    { type: 'TextBlock', text: '🎓 AI Career Coach', weight: 'Bolder', size: 'Medium', wrap: true },
    { type: 'TextBlock', text: p.greeting, spacing: 'Small', wrap: true },
    { type: 'TextBlock', text: 'What would you like to do?', spacing: 'Small', wrap: true },
    {
      type: 'ColumnSet',
      spacing: 'Medium',
      columns: [
        {
          type: 'Column',
          width: 1,
          items: [
            tile('🎯', 'Goal', 'Choose your path', 'goal'),
            tile('💬', 'Prep', 'Interview practice', 'prep'),
          ],
        },
        {
          type: 'Column',
          width: 1,
          items: [
            tile('📊', 'Skills', 'Find skill gaps', 'skills'),
            tile('📈', 'Progress', 'Track your growth', 'progress'),
          ],
        },
      ],
    },
  ];
  return AC(body);
}

function buildSkillPath(p: Extract<CardPayload, { type: 'skillPath' }>) {
  const interactive = p.interactive !== false; // default ON now
  const body: any[] = [
    header(`🎯 Skill path — ${p.roleTitle}`),
    sub(p.intro || (interactive
      ? 'Pick your current level for each skill (0 = never touched, 4 = advanced). We\'ll show your gaps and recommended courses next.'
      : 'Rate yourself 0-4 on each skill (0 = Not started, 4 = Advanced).')),
  ];

  if (!interactive) {
    body.push(table([2, 1, 3], [
      row([th('Skill'), th('Target'), th('Description')]),
      ...p.skills.map((s) => row([td(s.name), td(String(s.target)), td(s.description || '')])),
    ]));
    if (p.footer) body.push(sub(p.footer));
    return AC(body);
  }

  // Interactive mode: TABULAR layout. One row per skill with a compact ChoiceSet
  // (renders as a dropdown) so all 5 skills fit in a scannable grid.
  const ratingChoices = [
    { title: '0 · Not started', value: '0' },
    { title: '1 · Foundational', value: '1' },
    { title: '2 · Developing', value: '2' },
    { title: '3 · Proficient', value: '3' },
    { title: '4 · Advanced', value: '4' },
  ];

  // Reverse lookup for the read-only variant so we can show "3 · Proficient" instead of "3".
  const labelForLevel = (n: number): string => {
    const match = ratingChoices.find((c) => c.value === String(n));
    return match ? match.title : String(n);
  };

  const readOnly = !!p.readOnly;

  const skillMeta: Array<{ id: string; competencyId?: string; name: string; target: number }> = [];
  const tableRows: any[] = [
    row([th('#'), th('Skill'), th('Target Level'), th('Your current level')]),
  ];

  // Helper — wrap:false single-line cell text.
  const nowrapCell = (text: string, opts: { bold?: boolean; subtle?: boolean; small?: boolean } = {}) => ({
    type: 'TableCell',
    items: [{
      type: 'TextBlock',
      text,
      wrap: false,
      weight: opts.bold ? 'Bolder' : undefined,
      isSubtle: opts.subtle,
      size: opts.small ? 'Small' : undefined,
    }],
  });

  p.skills.forEach((s, idx) => {
    // Always coerce to an underscored id — Teams sometimes drops hyphens when
    // serializing Input.ChoiceSet values back on Action.Execute submit.
    const rawId = s.id || `skill_${idx + 1}`;
    const skillInputId = rawId.replace(/-/g, '_');
    skillMeta.push({ id: skillInputId, competencyId: s.competencyId, name: s.name, target: s.target });

    // Skill cell: name (bold) + optional description (subtle, small). Both wrap so long
    // names and full descriptions render across multiple lines instead of being truncated
    // with an ellipsis — keeps every skill self-explanatory in the card.
    const skillCellItems: any[] = [
      { type: 'TextBlock', text: s.name, weight: 'Bolder', wrap: true },
    ];
    if (s.description) {
      skillCellItems.push({ type: 'TextBlock', text: s.description, wrap: true, isSubtle: true, spacing: 'Small', size: 'Small' });
    }

    // Target Level cell — always shows "N · Label".
    const targetLevelCell = nowrapCell(labelForLevel(Number(s.target)));

    // Current level cell — dropdown (interactive) or plain label (read-only).
    const currentCell = readOnly
      ? nowrapCell(labelForLevel(Number(s.currentLevel ?? 0)))
      : {
        type: 'TableCell',
        items: [{
          type: 'Input.ChoiceSet',
          id: skillInputId,
          style: 'compact',            // dropdown — space-efficient inside a table cell
          isMultiSelect: false,
          // Default to '0' (Not started). Teams' compact ChoiceSet on Action.Execute
          // sometimes drops values the user picked but never touched; a default
          // guarantees SOMETHING is always submitted, so the flow never dead-ends.
          value: '0',
          placeholder: 'Pick 0–4 (default 0)',
          choices: ratingChoices,
        }],
      };

    tableRows.push({
      type: 'TableRow',
      cells: [
        nowrapCell(String(idx + 1)),
        { type: 'TableCell', items: skillCellItems },
        targetLevelCell,
        currentCell,
      ],
    });
  });

  body.push({
    type: 'Table',
    columns: [{ width: 0.3 }, { width: 3.5 }, { width: 1.7 }, { width: 2 }],
    firstRowAsHeaders: true,
    rows: tableRows,
  });

  if (p.footer) body.push(sub(p.footer));

  if (readOnly) {
    // A subtle "Submitted" badge in place of the action button so the user gets
    // clear feedback that their picks were accepted.
    body.push({
      type: 'TextBlock',
      text: '✅ Ratings submitted — see the plan below.',
      color: 'Good',
      weight: 'Bolder',
      wrap: false,
      spacing: 'Medium',
    });
    return AC(body);
  }

  const actions = [{
    type: 'Action.Execute',
    title: 'Continue — see my gaps',
    verb: 'careercoach_skill_ratings',
    data: {
      skills: skillMeta.map((s) => ({ id: s.id, competencyId: s.competencyId, name: s.name, target: s.target })),
      roleTitle: p.roleTitle,
    },
  }];
  return AC(body, actions);
}

function buildPlanReview(p: Extract<CardPayload, { type: 'planReview' }>) {
  const body: any[] = [
    header(`📊 Your Plan — ${p.roleTitle}`),
    sub(p.intro || 'Here are your skill gaps and the courses that will close them. Click 💾 Save my plan below to lock this in.'),
  ];

  // Reverse lookup — turn a numeric level into "3 · Proficient" etc., matching the skill-path card.
  const LEVEL_LABELS: Record<number, string> = {
    0: '0 · Not started',
    1: '1 · Foundational',
    2: '2 · Developing',
    3: '3 · Proficient',
    4: '4 · Advanced',
  };
  const levelLabel = (n: number): string => LEVEL_LABELS[Number(n)] ?? String(n);

  // Single-line no-wrap cell helper.
  const nowrapCell = (text: string, opts: { bold?: boolean; color?: string; subtle?: boolean } = {}) => ({
    type: 'TableCell',
    items: [{
      type: 'TextBlock',
      text,
      wrap: false,
      weight: opts.bold ? 'Bolder' : undefined,
      color: opts.color,
      isSubtle: opts.subtle,
    }],
  });

  // Wrapping cell helper for long content (skill names, courses).
  const wrapCell = (text: string, opts: { bold?: boolean; subtle?: boolean } = {}) => ({
    type: 'TableCell',
    items: [{
      type: 'TextBlock',
      text,
      wrap: true,
      weight: opts.bold ? 'Bolder' : undefined,
      isSubtle: opts.subtle,
    }],
  });

  // Header row — headers can wrap so long ones like "Recommended courses" don't get truncated.
  const headerCell = (text: string) => ({
    type: 'TableCell',
    items: [{ type: 'TextBlock', text, weight: 'Bolder', wrap: true }],
  });

  const tableRows: any[] = [
    {
      type: 'TableRow',
      cells: [
        headerCell('Skill'),
        headerCell('Target Level'),
        headerCell('Your Level'),
        headerCell('Status'),
        headerCell('Recommended courses'),
      ],
    },
  ];

  for (const s of p.skills) {
    const courses = s.courses ?? [];
    let courseCell: any;
    if (courses.length === 0) {
      // Show a different message when the user is already at target vs. when we have a gap
      // but couldn't find any matching course in the catalog.
      const msg = s.gap > 0
        ? 'No course currently available'
        : 'Already at target — no course needed';
      courseCell = wrapCell(msg, { subtle: true });
    } else {
      const items: any[] = [];
      courses.forEach((c, i) => {
        const range = (typeof c.fromLevel === 'number' && typeof c.toLevel === 'number')
          ? ` · L${c.fromLevel}→L${c.toLevel}` : '';
        const provider = c.provider ? ` · ${c.provider}` : '';
        const title = c.url ? `[${c.title} ↗](${c.url})` : `**${c.title}**`;
        items.push({
          type: 'TextBlock',
          text: `${title}${provider}${range}`,
          wrap: true,
          spacing: i === 0 ? 'None' : 'Small',
        });
      });
      courseCell = { type: 'TableCell', items };
    }
    tableRows.push({
      type: 'TableRow',
      cells: [
        wrapCell(s.name, { bold: true }),
        // Target / Your Level / Status stay single-line — no wrap, no ellipsis. The
        // columns below are widened enough that "1 · Foundational" and "🔴 To Build"
        // fit even in a moderately-narrow Teams window. If the chat pane is truly
        // pinched, Teams may still push overflow — widen your window or drop labels
        // to just the numbers.
        nowrapCell(levelLabel(Number(s.target))),
        nowrapCell(levelLabel(Number(s.current))),
        nowrapCell(`${statusDot(s.status)} ${s.status}`, { color: statusColor(s.status) }),
        courseCell,
      ],
    });
  }

  body.push({
    type: 'Table',
    // Column weights — Skill, Target Level, Your Level, and Status all get equal 2.5 units
    // so "🔴 To Build" fits on one line. Recommended courses gets 2.8; it still wraps
    // internally so long course titles + URLs flow to multiple lines naturally.
    columns: [{ width: 2.5 }, { width: 2.5 }, { width: 2.5 }, { width: 2.5 }, { width: 2.8 }],
    firstRowAsHeaders: true,
    rows: tableRows,
  });

  // Total course count summary.
  const totalCourses = typeof p.totalCourses === 'number'
    ? p.totalCourses
    : p.skills.reduce((acc, s) => acc + (s.courses?.length ?? 0), 0);
  const skillsWithCourses = p.skills.filter((s) => (s.courses?.length ?? 0) > 0).length;
  if (totalCourses > 0) {
    body.push({
      type: 'TextBlock',
      text: `📚 **${totalCourses}** courses across **${skillsWithCourses}** skill${skillsWithCourses === 1 ? '' : 's'} to close your gaps.`,
      wrap: true,
      spacing: 'Medium',
      isSubtle: true,
    });
  }

  if (p.footer) body.push(sub(p.footer));

  // Flatten the courses payload for the Save button. The LLM will receive the same structure
  // as ::save-plan:: {courseCount, groups:[{skill, courses:[...]}]} and persist to UserState.
  // We include the REAL SharePoint courseId (from LearningCatalog_v2) so Stage 3 doesn't
  // have to invent slugs — critical because Feature 1's LearningPortalStatus rows key on
  // that same CourseId.
  const groups = p.skills
    .filter((s) => (s.courses?.length ?? 0) > 0)
    .map((s) => ({
      skill: s.name,
      competencyId: s.competencyId,
      courses: (s.courses ?? []).map((c) => ({
        courseId: c.courseId,
        title: c.title, url: c.url, provider: c.provider, format: c.format,
        fromLevel: c.fromLevel, toLevel: c.toLevel,
      })),
    }));
  // Also carry every skill's rating snapshot (competencyId + name + current + target)
  // so the deterministic Save handler can build Skills[] + Goals[] without re-reading.
  const ratings = p.skills.map((s) => ({
    competencyId: s.competencyId,
    name: s.name,
    level: s.current,
    target: s.target,
  }));
  const actions = [{
    type: 'Action.Execute',
    title: '💾 Save my plan',
    verb: 'careercoach_save_plan',
    style: 'positive',
    data: { courseCount: totalCourses, groups, ratings, roleTitle: p.roleTitle },
  }];
  return AC(body, actions);
}

function buildGapAnalysis(p: Extract<CardPayload, { type: 'gapAnalysis' }>) {
  const body: any[] = [
    header(`📊 Skill gap analysis — ${p.roleTitle}`),
    table([2, 1, 1, 1, 1], [
      row([th('Skill'), th('Target'), th('You'), th('Gap'), th('Status')]),
      ...p.skills.map((s) =>
        row([td(s.name), td(String(s.target)), td(String(s.current)), td(String(s.gap)), td(`${statusDot(s.status)} ${s.status}`, statusColor(s.status))])
      ),
    ]),
  ];
  if (p.goals?.length) {
    body.push({ type: 'TextBlock', text: '🎯 Development goals', weight: 'Bolder', spacing: 'Medium', wrap: true });
    body.push({ type: 'TextBlock', text: p.goals.map((g, i) => `${i + 1}. ${g}`).join('\n'), wrap: true });
  }
  if (p.footer) body.push(sub(p.footer));
  return AC(body);
}

function buildCourses(p: Extract<CardPayload, { type: 'courses' }>) {
  const body: any[] = [header('📚 Recommended courses')];
  if (p.intro) body.push(sub(p.intro));
  // Flat course list captured for the Save button so the LLM handler knows what to save.
  const flatCourses: Array<{ title: string; url?: string; provider?: string; format?: string; skill?: string }> = [];
  for (const g of p.groups) {
    body.push({ type: 'TextBlock', text: g.skill, weight: 'Bolder', spacing: 'Medium', wrap: true });
    for (const c of g.courses) {
      flatCourses.push({ ...c, skill: g.skill });
      const meta = [c.provider, c.format].filter(Boolean).join(' · ');
      const titleMarkdown = c.url ? `**[${c.title}](${c.url})**` : `**${c.title}**`;
      body.push({
        type: 'ColumnSet',
        spacing: 'Small',
        columns: [
          { type: 'Column', width: 'auto', items: [{ type: 'Image', url: GRAD_ICON, size: 'Small', altText: 'course' }] },
          {
            type: 'Column', width: 'stretch', verticalContentAlignment: 'Center', items: [
              { type: 'TextBlock', text: titleMarkdown, wrap: true },
              ...(meta ? [{ type: 'TextBlock', text: meta, isSubtle: true, spacing: 'None', wrap: true }] : []),
              ...(c.url
                ? [{ type: 'TextBlock', text: `[Open in LinkedIn Learning ↗](${c.url})`, wrap: true, isSubtle: true, spacing: 'None', size: 'Small' }]
                : []),
            ],
          },
        ],
      });
    }
  }
  if (p.footer) body.push(sub(p.footer));

  // Save button — user clicks once, agent persists the plan (Stage 3 save) with no text back-and-forth.
  const actions = [{
    type: 'Action.Execute',
    title: '💾 Save my plan',
    verb: 'careercoach_save_plan',
    style: 'positive',
    data: {
      courseCount: flatCourses.length,
      groups: p.groups.map((g) => ({ skill: g.skill, courses: g.courses.map((c) => ({ title: c.title, url: c.url, provider: c.provider, format: c.format })) })),
    },
  }];
  return AC(body, actions);
}

function buildProgress(p: Extract<CardPayload, { type: 'progress' }>) {
  const body: any[] = [header(p.roleTitle ? `🚀 Your progress — ${p.roleTitle}` : '🚀 Your progress')];
  // Always derive overall from the goals so the bar can't disagree with the rows below it.
  const overall = deriveOverall(p.goals, p.overall);
  if (typeof overall === 'number') {
    body.push({ type: 'TextBlock', text: progressBar(overall), wrap: true, spacing: 'Small' });
  }
  body.push(table([3, 2, 2], [
    row([th('Goal'), th('Progress'), th('Status')]),
    ...p.goals.map((g) => row([td(g.name), td(progressBar(g.progressPct)), td(g.status || '')])),
  ]));
  if (p.learning?.length) {
    body.push({ type: 'TextBlock', text: '📚 Courses in your plan', weight: 'Bolder', size: 'Medium', spacing: 'Medium', wrap: true });
    body.push(table([3, 2, 2], [
      row([th('Course'), th('Skill'), th('Status')]),
      ...p.learning.map((c) => row([td(c.title), td(c.skill || ''), td(c.status || '', c.status === 'Complete' ? 'Good' : undefined)])),
    ]));
  }
  if (p.footer) body.push(sub(p.footer));
  return AC(body);
}

function buildRoadmap(p: Extract<CardPayload, { type: 'roadmap' }>) {
  const badge = (state?: string) => (state === 'done' ? '✅' : state === 'current' ? '🔵' : '⚪');
  const body: any[] = [header(`🗺️ Roadmap — ${p.roleTitle}`)];
  p.stages.forEach((s, i) => {
    body.push({
      type: 'ColumnSet',
      spacing: i === 0 ? 'Medium' : 'Small',
      columns: [
        { type: 'Column', width: 'auto', verticalContentAlignment: 'Center', items: [{ type: 'TextBlock', text: badge(s.state), size: 'Large' }] },
        {
          type: 'Column', width: 'stretch', items: [
            { type: 'TextBlock', text: `${i + 1}. ${s.label}`, weight: 'Bolder', wrap: true, spacing: 'None' },
            ...(s.detail ? [{ type: 'TextBlock', text: s.detail, isSubtle: true, spacing: 'None', wrap: true }] : []),
          ],
        },
      ],
    });
  });
  if (p.footer) body.push(sub(p.footer));
  return AC(body);
}

function buildPrepBrief(p: Extract<CardPayload, { type: 'prepBrief' }>) {
  const label = (text: string) => ({ type: 'TextBlock', text, weight: 'Bolder', size: 'Medium', spacing: 'Medium', wrap: true });
  const body: any[] = [header(p.roleTitle ? `🎤 1:1 Prep — ${p.roleTitle}` : '🎤 Your 1:1 prep brief')];
  const overall = deriveOverall(p.goals, p.overall);
  if (typeof overall === 'number') {
    body.push({ type: 'TextBlock', text: `Overall progress: ${progressBar(overall)}`, wrap: true, spacing: 'Small' });
  }

  if (p.wins?.length) {
    body.push(label('🏆 Key wins'));
    for (const w of p.wins) {
      body.push({
        type: 'Container', spacing: 'Small', style: 'emphasis', bleed: false, items: [
          { type: 'TextBlock', text: w.title, weight: 'Bolder', wrap: true },
          { type: 'TextBlock', text: w.star, wrap: true, isSubtle: true, spacing: 'None' },
        ],
      });
    }
  }

  if (p.managerAsks) {
    body.push(label("✅ Where you addressed your manager's asks"));
    body.push({ type: 'TextBlock', text: p.managerAsks, wrap: true });
  }

  if (p.talkingPoints?.length) {
    body.push(label('💬 Talking points'));
    body.push({ type: 'TextBlock', text: p.talkingPoints.map((t, i) => `${i + 1}. ${t}`).join('\n'), wrap: true });
  }

  if (p.questions?.length) {
    body.push(label('❓ Questions to ask your manager'));
    body.push({ type: 'TextBlock', text: p.questions.map((q) => `• ${q}`).join('\n'), wrap: true });
  }

  if (p.footer) body.push(sub(p.footer));
  return AC(body);
}

function buildQuiz(p: Extract<CardPayload, { type: 'quiz' }>) {
  const heading = p.skillName ? `📝 Quick check — ${p.courseTitle}` : `📝 Quick check — ${p.courseTitle}`;
  const introText = p.intro
    || `Answer 5 short questions to lock in what you learned${p.skillName ? ` in ${p.skillName}` : ''}. You'll advance when you get 4 out of 5.`;
  const body: any[] = [header(heading), sub(introText)];

  p.questions.forEach((q, i) => {
    const qNum = i + 1;
    // The LLM sometimes emits question text already prefixed with "1." / "Q1:" / etc.
    // Strip any such leading marker so our own numbering is the single source of truth.
    const cleaned = String(q.text ?? '').replace(/^\s*(?:Q\s*)?\d+\s*[\.\):-]\s*/i, '').trim();
    // Use "Q1." style (not "1.") — Teams' Adaptive Card renderer treats leading "N. text"
    // as a markdown ordered list and resets the visible number to "1." for every TextBlock,
    // making all questions look identically numbered. "Q1." is unambiguously a label and
    // renders correctly as literal "Q1.", "Q2.", "Q3.", "Q4.", "Q5.".
    body.push({ type: 'TextBlock', text: `Q${qNum}. ${cleaned}`, weight: 'Bolder', wrap: true, spacing: 'Medium' });
    if (q.type === 'mcq' && q.choices && q.choices.length) {
      body.push({
        type: 'Input.ChoiceSet',
        id: q.id,
        style: 'expanded',
        isMultiSelect: false,
        choices: q.choices.map((label, idx) => ({
          title: label,
          value: String.fromCharCode(65 + idx), // 'A', 'B', 'C', 'D'
        })),
      });
    } else {
      body.push({
        type: 'Input.Text',
        id: q.id,
        placeholder: 'Type your answer (1–2 sentences)…',
        isMultiline: true,
      });
    }
  });

  if (p.footer) body.push(sub(p.footer));

  // Action.Execute (not Action.Submit) — matches the agent's actionExecute handler pattern.
  const actions = [{
    type: 'Action.Execute',
    title: 'Submit answers',
    verb: 'careercoach_quiz_submit',
    data: {
      courseId: p.courseId,
      skillId: p.skillId,
      // Include the question metadata so the handler can round-trip it back into the LLM turn
      // for grading — the LLM authored these questions and knows the correct answers.
      questionMeta: p.questions.map((q) => ({ id: q.id, type: q.type, topicTag: q.topicTag })),
    },
  }];
  return AC(body, actions);
}

function buildQuizResult(p: Extract<CardPayload, { type: 'quizResult' }>) {
  const passHeader = p.passed
    ? `✅ Nice work — you passed! (${p.score}/${p.total})`
    : `🔄 Not quite (${p.score}/${p.total}) — you can try again`;
  const bannerColor = p.passed ? 'Good' : 'Warning';
  const body: any[] = [
    header(`📝 Quiz result — ${p.courseTitle}`),
    { type: 'TextBlock', text: passHeader, weight: 'Bolder', color: bannerColor, wrap: true, spacing: 'Small' },
  ];
  if (p.skillName) body.push(sub(`Skill: ${p.skillName}`));

  p.feedback.forEach((f, i) => {
    const badge = f.correct ? '✅' : '❌';
    body.push({
      type: 'Container',
      spacing: 'Medium',
      style: f.correct ? 'good' : 'attention',
      items: [
        { type: 'TextBlock', text: `${badge} Q${i + 1}. ${f.text}`, weight: 'Bolder', wrap: true },
        { type: 'TextBlock', text: `Your answer: ${f.userAnswer || '(no answer)'}`, wrap: true, spacing: 'Small' },
        ...(f.correct
          ? []
          : [{ type: 'TextBlock', text: `Correct answer: ${f.correctAnswer}`, wrap: true, isSubtle: true, spacing: 'Small' }]),
        ...(f.explanation
          ? [{ type: 'TextBlock', text: f.explanation, wrap: true, isSubtle: true, spacing: 'Small' }]
          : []),
        { type: 'TextBlock', text: `Topic: ${f.topicTag}`, wrap: true, isSubtle: true, size: 'Small', spacing: 'Small' },
      ],
    });
  });

  if (p.footer) body.push(sub(p.footer));
  return AC(body);
}

function buildMilestone80(p: Extract<CardPayload, { type: 'milestone80' }>) {
  const heading = p.roleTitle
    ? `🎯 You're 80% there — ${p.roleTitle}`
    : `🎯 You're 80% of the way to your goal`;
  const body: any[] = [
    header(heading),
    { type: 'TextBlock', text: `Overall progress: ${progressBar(p.overall)}`, wrap: true, spacing: 'Small' },
    sub("Amazing momentum — you're in the final stretch. Here's what's left and where a little extra practice will pay off."),
  ];

  if (p.stillToClose.length) {
    body.push({ type: 'TextBlock', text: '🔜 Still to close', weight: 'Bolder', size: 'Medium', spacing: 'Medium', wrap: true });
    body.push(table([3, 3], [
      row([th('Goal'), th('Progress')]),
      ...p.stillToClose.map((g) => row([td(g.name), td(progressBar(g.progressPct))])),
    ]));
  } else {
    body.push({
      type: 'TextBlock', wrap: true, weight: 'Bolder', color: 'Good', spacing: 'Medium',
      text: '🎉 All goals are complete — just some polishing left!',
    });
  }

  if (p.areasToStrengthen.length) {
    body.push({ type: 'TextBlock', text: '🧠 Areas to strengthen', weight: 'Bolder', size: 'Medium', spacing: 'Medium', wrap: true });
    body.push(sub('These topics came up in the quiz questions you missed — worth a quick review.'));
    body.push({
      type: 'Container', style: 'emphasis', spacing: 'Small',
      items: p.areasToStrengthen.map((tag) => ({ type: 'TextBlock', text: `• ${tag}`, wrap: true, spacing: 'None' })),
    });
  }

  if (p.footer) body.push(sub(p.footer));
  return AC(body);
}

function buildCompletionSummary(p: Extract<CardPayload, { type: 'completionSummary' }>) {
  const heading = p.roleTitle
    ? `🎓 Plan complete — ${p.roleTitle}!`
    : '🎓 Career plan complete!';
  const body: any[] = [
    header(heading),
    { type: 'TextBlock', text: `Overall progress: ${progressBar(100)}`, wrap: true, spacing: 'Small' },
  ];

  const stats: string[] = [];
  if (typeof p.coursesCompleted === 'number') stats.push(`✅ ${p.coursesCompleted} courses completed`);
  if (typeof p.totalTimeMinutes === 'number') {
    const h = Math.floor(p.totalTimeMinutes / 60);
    const m = p.totalTimeMinutes % 60;
    const tstr = h > 0 ? `${h}h ${m}m` : `${m}m`;
    stats.push(`⏱️ ${tstr} invested`);
  }
  if (stats.length) {
    body.push({
      type: 'Container', style: 'emphasis', spacing: 'Medium',
      items: stats.map((s) => ({ type: 'TextBlock', text: s, wrap: true, spacing: 'None', weight: 'Bolder' })),
    });
  }

  const emailLine: string[] = [];
  if (p.sent) {
    emailLine.push('📧 Celebration email sent');
    if (p.managerName || p.managerEmail) {
      emailLine.push(`  → to ${p.managerName ?? p.managerEmail}`);
    }
    if (p.userEmail) emailLine.push(`  → cc: ${p.userEmail}`);
    if (p.subject) emailLine.push(`  Subject: "${p.subject}"`);
  } else {
    emailLine.push('📧 Email was not sent — see note below.');
    if (p.note) emailLine.push(p.note);
  }
  body.push({
    type: 'Container', spacing: 'Medium',
    items: emailLine.map((s) => ({ type: 'TextBlock', text: s, wrap: true, spacing: 'None' })),
  });

  if (p.note && p.sent) body.push(sub(p.note));
  if (p.footer) body.push(sub(p.footer));
  return AC(body);
}

function buildCard(payload: CardPayload): any | undefined {
  switch (payload.type) {
    case 'welcome': return buildWelcome(payload);
    case 'skillPath': return buildSkillPath(payload);
    case 'gapAnalysis': return buildGapAnalysis(payload);
    case 'planReview': return buildPlanReview(payload);
    case 'courses': return buildCourses(payload);
    case 'progress': return buildProgress(payload);
    case 'roadmap': return buildRoadmap(payload);
    case 'prepBrief': return buildPrepBrief(payload);
    case 'quiz': return buildQuiz(payload);
    case 'quizResult': return buildQuizResult(payload);
    case 'milestone80': return buildMilestone80(payload);
    case 'completionSummary': return buildCompletionSummary(payload);
    default: return undefined;
  }
}

/**
 * Public wrapper — hands back a fully-wrapped Adaptive Card attachment for any
 * CardPayload. Handlers use this to render deterministic cards without going
 * through the LLM.
 */
export function renderCard(payload: CardPayload): Attachment | undefined {
  const card = buildCard(payload);
  return card ? CardFactory.adaptiveCard(card) : undefined;
}

/**
 * A ready-made welcome card (used on install, where there is no LLM turn).
 */
export function defaultWelcomeAttachment(name?: string): Attachment {
  return CardFactory.adaptiveCard(buildWelcome({
    type: 'welcome',
    greeting: name ? `Hi ${name}! 👋` : 'Hi there! 👋',
    tagline: "I'm your private AI Career Coach.",
    prompt: "To get started, tell me your current role, your years of experience, and where you'd like to grow. 🌟",
  }));
}

/**
 * Wraps plain conversational prose in a simple Adaptive Card so every agent
 * response renders as a card (consistent, polished conversation).
 *
 * IMPORTANT: We split by paragraphs (blank-line separators), NOT by every line.
 * Teams' Adaptive Card renderer treats each TextBlock as its own markdown context —
 * if we emit one TextBlock per line and a paragraph contains "1. …", "2. …", "3. …"
 * the renderer sees each line as a fresh ordered list starting at 1 and every item
 * displays as "1." (the visible number is thrown away). By keeping paragraphs intact
 * inside a single TextBlock, ordered lists render with correct numbering.
 */
export function buildMessageCard(text: string): Attachment {
  // Split on 2+ newlines = paragraph boundary; keep intra-paragraph newlines so
  // multi-line ordered/bulleted lists stay as one markdown block inside one TextBlock.
  const paragraphs = String(text ?? '')
    .split(/\r?\n\r?\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const body = paragraphs.length
    ? paragraphs.map((p, i) => ({ type: 'TextBlock', text: p, wrap: true, spacing: i === 0 ? 'None' : 'Medium' }))
    : [{ type: 'TextBlock', text, wrap: true }];
  return CardFactory.adaptiveCard(AC(body));
}

/**
 * Splits an LLM response into leading prose + Adaptive Card attachments.
 * Recognizes fenced ```card blocks whose body is a JSON CardPayload.
 * On any parse error the block is left as-is in the text (never dropped).
 */
export function extractCards(response: string): { text: string; attachments: Attachment[] } {
  const attachments: Attachment[] = [];
  const fence = /```card\s*([\s\S]*?)```/gi;
  let text = response;
  let m: RegExpExecArray | null;
  const toStrip: string[] = [];

  while ((m = fence.exec(response)) !== null) {
    const raw = m[1].trim();
    try {
      const payload = JSON.parse(raw) as CardPayload;
      const card = buildCard(payload);
      if (card) {
        attachments.push(CardFactory.adaptiveCard(card));
        toStrip.push(m[0]);
      }
    } catch {
      // leave the block in the text so the user still sees something
    }
  }
  for (const block of toStrip) text = text.replace(block, '');
  return { text: text.trim(), attachments };
}
