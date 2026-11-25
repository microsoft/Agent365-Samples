// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getJiraConfig, getScheduleConfig, getWarnConfig } = require('../src/config.ts');

function withJiraEnv(values, run) {
    const original = {};
    for (const [name, value] of Object.entries(values)) {
        original[name] = process.env[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    try {
        run();
    } finally {
        for (const [name, value] of Object.entries(original)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
}

test('live Jira requires an explicitly configured positive safe board ID', () => {
    withJiraEnv({
        JIRA_MODE: 'live',
        JIRA_BASE_URL: 'https://example.atlassian.net',
        JIRA_EMAIL: 'test@example.com',
        JIRA_API_TOKEN: 'test-placeholder',
        JIRA_PROJECT_KEY: 'TEST',
    }, () => {
        for (const value of [undefined, '', '  ']) {
            withJiraEnv({ JIRA_BOARD_ID: value }, () => {
                assert.throws(() => getJiraConfig(), /Missing required env var: JIRA_BOARD_ID/);
            });
        }
        for (const value of ['invalid', 'NaN', 'Infinity', '-Infinity', '0', '-1', '1.5', '9007199254740992']) {
            withJiraEnv({ JIRA_BOARD_ID: value }, () => {
                assert.throws(() => getJiraConfig(), /JIRA_BOARD_ID must be a positive safe integer/);
            });
        }
        for (const value of ['1', ' 42 ', '9007199254740991']) {
            withJiraEnv({ JIRA_BOARD_ID: value }, () => {
                assert.equal(getJiraConfig().boardId, Number(value));
            });
        }
    });
});

test('mock Jira retains its offline default without live credentials', () => {
    withJiraEnv({
        JIRA_MODE: 'mock',
        JIRA_BASE_URL: undefined,
        JIRA_EMAIL: undefined,
        JIRA_API_TOKEN: undefined,
        JIRA_PROJECT_KEY: undefined,
    }, () => {
        for (const value of [undefined, '', 'invalid']) {
            withJiraEnv({ JIRA_BOARD_ID: value }, () => {
                assert.equal(getJiraConfig().boardId, 1);
            });
        }
        withJiraEnv({ JIRA_BOARD_ID: '42' }, () => {
            assert.equal(getJiraConfig().boardId, 42);
        });
    });
});

test('cutoff configuration retains defaults and accepts positive Node-supported durations', () => {
    for (const value of [undefined, '', '  ']) {
        withJiraEnv({ STANDUP_CUTOFF_HOURS: value }, () => {
            assert.equal(getScheduleConfig().cutoffHours, 4);
        });
    }
    for (const hours of [1 / 3600_000, 0.5, 4, 24, 48, 2_147_483_647 / 3600_000]) {
        withJiraEnv({ STANDUP_CUTOFF_HOURS: String(hours) }, () => {
            assert.equal(getScheduleConfig().cutoffHours, hours);
        });
    }
});

test('cutoff configuration rejects invalid, nonpositive, sub-millisecond and overflowing timers', () => {
    for (const value of ['invalid', 'NaN', 'Infinity', '-Infinity', '0', '-1', '1e-20',
        String(2_147_483_648 / 3600_000), '1e308']) {
        withJiraEnv({ STANDUP_CUTOFF_HOURS: value }, () => {
            assert.throws(() => getScheduleConfig(), /STANDUP_CUTOFF_HOURS must be a finite number/);
        });
    }
});

test('warning fractions retain defaults and accept both boundaries', () => {
    withJiraEnv({ WARN_TODO_PCT: undefined, WARN_SPRINT_PROGRESS_PCT: '' }, () => {
        assert.deepEqual(getWarnConfig(), { todoPct: 0.4, sprintProgressPct: 0.5 });
    });
    for (const value of ['0', '0.25', '1']) {
        withJiraEnv({ WARN_TODO_PCT: value, WARN_SPRINT_PROGRESS_PCT: value }, () => {
            assert.deepEqual(getWarnConfig(), { todoPct: Number(value), sprintProgressPct: Number(value) });
        });
    }
});

test('warning fractions reject invalid and out-of-range settings independently', () => {
    for (const name of ['WARN_TODO_PCT', 'WARN_SPRINT_PROGRESS_PCT']) {
        for (const value of ['invalid', 'NaN', 'Infinity', '-Infinity', '-0.01', '1.01', '40']) {
            withJiraEnv({ WARN_TODO_PCT: '0.4', WARN_SPRINT_PROGRESS_PCT: '0.5', [name]: value }, () => {
                assert.throws(() => getWarnConfig(), new RegExp(`${name} must be a finite number between 0 and 1`));
            });
        }
    }
});
