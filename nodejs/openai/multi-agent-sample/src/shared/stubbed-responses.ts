// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { PlanOutput, ExecutorOutput, ReviewOutput, CrmContact, CrmCampaign, CrmActivity } from './types';

export const STUBBED_PLAN: PlanOutput = {
  targetSegment: 'Enterprise accounts in EMEA with >500 employees',
  channels: ['email', 'linkedin', 'webinar'],
  constraints: [
    'Must include opt-out mechanism per GDPR',
    'Budget cap: $50,000',
    'Timeline: 4 weeks',
  ],
  timeline: '2026-03-10 to 2026-04-07',
};

function generateContacts(count: number): CrmContact[] {
  const companies = [
    'Contoso', 'Fabrikam', 'Northwind', 'Adatum', 'VanArsdel',
    'Trey Research', 'Litware', 'Proseware', 'Coho Winery', 'Lucerne Publishing',
  ];
  const firstNames = [
    'Alice', 'Bob', 'Carol', 'David', 'Eva',
    'Frank', 'Grace', 'Hank', 'Iris', 'Jack',
  ];
  const contacts: CrmContact[] = [];
  for (let i = 0; i < count; i++) {
    const company = companies[i % companies.length];
    const name = firstNames[i % firstNames.length];
    contacts.push({
      id: `c-${String(i + 1).padStart(3, '0')}`,
      name: `${name} ${company}`,
      email: `${name.toLowerCase()}@${company.toLowerCase()}.com`,
      segment: 'Enterprise-EMEA',
    });
  }
  return contacts;
}

export const STUBBED_CONTACTS: CrmContact[] = generateContacts(50);

export const STUBBED_CAMPAIGN: CrmCampaign = {
  id: 'cmp-demo-001',
  name: 'Q1 EMEA Enterprise Outreach',
  status: 'draft',
  targetCount: 50,
};

export const STUBBED_DRAFT_OUTPUT: ExecutorOutput = {
  mode: 'draft',
  contacts: STUBBED_CONTACTS,
  campaign: STUBBED_CAMPAIGN,
};

/** First review always blocks — missing opt-out */
export const STUBBED_BLOCK_REVIEW: ReviewOutput = {
  status: 'blocked',
  reason: 'Campaign email template is missing GDPR opt-out link. All outreach to EMEA contacts must include an unsubscribe mechanism.',
  fixes: ['Add opt-out link to email template', 'Add unsubscribe landing page URL'],
};

function generateActivities(contacts: CrmContact[], touchesPerContact: number): CrmActivity[] {
  const activities: CrmActivity[] = [];
  let counter = 1;
  for (const contact of contacts) {
    for (let t = 1; t <= touchesPerContact; t++) {
      activities.push({
        id: `act-${String(counter++).padStart(3, '0')}`,
        type: 'email',
        description: `Touch ${t}: Updated email with opt-out link for ${contact.name}`,
        contactId: contact.id,
      });
    }
  }
  return activities;
}

export const STUBBED_ACTIVITIES: CrmActivity[] = generateActivities(STUBBED_CONTACTS, 3);

export const STUBBED_FIX_OUTPUT: ExecutorOutput = {
  mode: 'fix',
  activities: STUBBED_ACTIVITIES,
};

/** Second review approves */
export const STUBBED_APPROVE_REVIEW: ReviewOutput = {
  status: 'approved',
  reason: 'All GDPR compliance requirements met. Opt-out links verified. Campaign approved for launch.',
};
