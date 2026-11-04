// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { defineTool, type Tool } from '@github/copilot-sdk';
import type { InvocationTelemetry } from './telemetry.js';

export function addNumbers(args: unknown): number {
  if (typeof args !== 'object' || args === null ||
      !('a' in args) || !('b' in args) ||
      typeof args.a !== 'number' || typeof args.b !== 'number' ||
      !Number.isFinite(args.a) || !Number.isFinite(args.b) ||
      !Number.isFinite(args.a + args.b)) {
    throw new Error('add_numbers requires finite numbers a and b with a finite sum');
  }
  return args.a + args.b;
}

export function failDeliberately(): never {
  throw new Error('Intentional deterministic tool failure');
}

export function createTools(events: InvocationTelemetry): Tool[] {
  return [
    defineTool('add_numbers', {
      description: 'Add two finite numbers deterministically. No network or filesystem access.',
      parameters: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
        additionalProperties: false,
      },
      skipPermission: true,
      handler: (args, invocation) => events.executeTool(invocation, () => addNumbers(args)),
    }),
    defineTool('fail_deliberately', {
      description: 'Always fails. Use only when explicitly asked to exercise the failure path.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      skipPermission: true,
      handler: (_args, invocation) => events.executeTool(invocation, failDeliberately),
    }),
  ];
}
