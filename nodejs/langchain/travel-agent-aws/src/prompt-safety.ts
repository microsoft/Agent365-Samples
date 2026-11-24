// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Wraps text written by document users (Word comment, commenter name, document name) in a
// delimited block the system prompt tells the model to treat as data, never as instructions.

// Control characters except \t and \n, plus bidi overrides that can visually reorder text.
const UNSAFE_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;
const TAG_LIKE = /<(\s*\/?\s*untrusted)/gi;

export function untrustedBlock(tag: string, value: unknown, maxLen: number): string {
  if (!/^[a-z_]+$/.test(tag)) throw new Error('untrustedBlock tag must be lowercase letters or underscores');
  let text = String(value ?? '').replace(UNSAFE_CHARS, '').replace(TAG_LIKE, '‹$1');
  if (text.length > maxLen) text = `${text.slice(0, maxLen)}…`;
  return `<untrusted_${tag}>\n${text}\n</untrusted_${tag}>\n`;
}
