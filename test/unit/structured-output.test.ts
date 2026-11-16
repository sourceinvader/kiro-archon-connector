import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { augmentPromptForJsonSchema, tryParseStructuredOutput } from '../../src/structured-output';

describe('augmentPromptForJsonSchema', () => {
  test('keeps the prompt and appends the schema', () => {
    const prompt = augmentPromptForJsonSchema('Classify this.', { type: 'object', properties: { kind: { type: 'string' } } });
    expect(prompt.startsWith('Classify this.')).toBe(true);
    expect(prompt).toContain('"kind"');
    expect(prompt).toContain('ONLY a JSON object');
  });
});

describe('tryParseStructuredOutput', () => {
  test('parses the recorded Kiro structured reply (leading blank lines included)', () => {
    const finished = readFileSync(join(import.meta.dir, '..', 'fixtures', 'structured.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
      .find(line => line.type === 'runFinished');
    expect(tryParseStructuredOutput(finished.data.finalText)).toEqual({ answer: '4' });
  });

  test('tier 1: plain and fenced JSON', () => {
    expect(tryParseStructuredOutput('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseStructuredOutput('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  test('tier 2: prose preamble before the object', () => {
    expect(tryParseStructuredOutput('Here you go:\n{"a":1}')).toEqual({ a: 1 });
  });

  test('tier 3: repairs trailing commas and single quotes', () => {
    expect(tryParseStructuredOutput("{'a': 1,}")).toEqual({ a: 1 });
  });

  test('refuses non-objects and prose', () => {
    for (const text of ['', '   ', '[1,2]', '42', 'null', 'no json here', '{not valid']) {
      expect(tryParseStructuredOutput(text)).toBeUndefined();
    }
  });
});
