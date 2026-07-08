// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// A365AgentforceTool — the in-band Agentforce Apex action (@InvocableMethod).
//
// When an Agentforce agent invokes this action during a turn, it ORIGINATES an Agent 365
// `execute_tool` span (and, via A365Telemetry, the session's `invoke_agent` root) using the
// deterministic seed scheme — making the Agentforce turn surface as a first-class agent trace
// under the configured agent identity, not just a tool span hanging off an external agent.
//
// Telemetry is fail-open + async (Queueable) + config-gated (OriginateEnabled__c): it never
// affects the turn's latency or success.
//
// The trace seed comes from the optional SessionId input when the Agent Builder maps it in,
// else a per-request fallback; the reply reports which was used.
global with sharing class A365AgentforceTool {

    global class Request {
        @InvocableVariable(label='Prompt' description='Text sent from the Agentforce turn' required=true)
        global String prompt;

        @InvocableVariable(label='SessionId' description='Agentforce conversation/session id, if the agent maps it into the action input. Used as the trace seed so every span of the conversation shares one trace.')
        global String sessionId;
    }

    global class Response {
        @InvocableVariable(label='Reply' description='Text returned to the Agentforce turn')
        global String reply;
    }

    @InvocableMethod(label='A365 Echo' description='Echoes the prompt and originates an Agent 365 execute_tool span for this Agentforce turn (fail-open telemetry).')
    global static List<Response> run(List<Request> requests) {
        List<Response> responses = new List<Response>();
        if (requests == null) {
            return responses;
        }
        for (Request r : requests) {
            // Capture the Apex execution window for the span (nanoseconds, epoch-based).
            Long startNs = System.now().getTime() * 1000000L;

            String prompt = (r != null && r.prompt != null) ? r.prompt : '';
            Boolean haveSession = (r != null && String.isNotBlank(r.sessionId));
            String seed = haveSession ? r.sessionId : fallbackSeed();

            Response res = new Response();
            res.reply = 'A365 Agentforce echo: '
                + (String.isBlank(prompt) ? 'hello' : 'you said "' + prompt + '"')
                + '. '
                + (haveSession
                    ? 'sessionId received — in-band seeding active.'
                    : 'no sessionId in input — fallback seed used.');

            // Originate this turn's execute_tool span. originateToolSpan ensures the session's
            // invoke_agent root exists first (deduped). Fully fail-open inside A365Telemetry.
            A365Telemetry.originateToolSpan(
                seed,
                'execute_tool A365AgentforceTool',
                new Map<String, Object>{
                    'gen_ai.operation.name' => 'execute_tool',
                    'gen_ai.tool.name' => 'A365AgentforceTool',
                    'gen_ai.tool.type' => 'salesforce-apex',
                    'sf.org.id' => UserInfo.getOrganizationId(),
                    'sf.seed.source' => haveSession ? 'input.sessionId' : 'fallback'
                },
                startNs,
                System.now().getTime() * 1000000L,
                true);

            responses.add(res);
        }
        return responses;
    }

    // Per-request fallback seed when the builder doesn't expose a conversation id. Unique per
    // invocation so a valid (if un-grouped) trace is still originated; deterministic grouping
    // across a real conversation comes from the SessionId input.
    private static String fallbackSeed() {
        return 'af-sample-' + UserInfo.getOrganizationId() + '-'
            + String.valueOf(System.now().getTime()) + '-'
            + String.valueOf(Math.abs(Crypto.getRandomLong()));
    }
}