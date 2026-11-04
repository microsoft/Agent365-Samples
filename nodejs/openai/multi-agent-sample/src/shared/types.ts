// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/** Full pipeline state passed between orchestrator steps */
export interface PipelineState {
  runId: string;
  scenario: string;
  teamId: string;
  userRequest: string;
  step: number;
  plan?: PlanOutput;
  draftArtifacts?: ExecutorOutput;
  reviewResult?: ReviewOutput;
  fixArtifacts?: ExecutorOutput;
  finalReview?: ReviewOutput;
}

export interface PlanOutput {
  targetSegment: string;
  channels: string[];
  constraints: string[];
  timeline: string;
}

export interface ExecutorOutput {
  mode: 'draft' | 'fix';
  contacts?: CrmContact[];
  campaign?: CrmCampaign;
  activities?: CrmActivity[];
}

export interface CrmContact {
  id: string;
  name: string;
  email: string;
  segment: string;
}

export interface CrmCampaign {
  id: string;
  name: string;
  status: string;
  targetCount: number;
}

export interface CrmActivity {
  id: string;
  type: string;
  description: string;
  contactId: string;
}

export interface ReviewOutput {
  status: 'blocked' | 'approved';
  reason: string;
  fixes?: string[];
}

/** Standard request body for inter-agent HTTP calls */
export interface AgentRequest {
  runId: string;
  step: number;
  payload: Record<string, unknown>;
}

/** Standard response body from sub-agent services */
export interface AgentResponse {
  runId: string;
  step: number;
  result: Record<string, unknown>;
}
