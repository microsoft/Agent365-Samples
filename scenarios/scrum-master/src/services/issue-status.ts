// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export function isIssueDone(issue: { status: string; statusCategory?: string | null }): boolean {
    return issue.statusCategory != null ? issue.statusCategory === 'done' : issue.status === 'Done';
}
