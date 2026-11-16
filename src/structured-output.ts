/**
 * Best-effort structured output for a runtime without a grammar-constrained channel.
 *
 * Adapted from Archon's `packages/providers/src/shared/structured-output.ts` (v0.14.0,
 * MIT, Copyright (c) 2025-2026 Cole Medin), which its Copilot provider uses for the same
 * `structuredOutput: 'best-effort'` tier. Keeping the same prompt and parse tiers means a
 * Kiro node behaves like the other best-effort providers when the engine validates it.
 */
import { jsonrepair } from 'jsonrepair';

/** Append a "respond with JSON matching this schema" instruction to the user prompt. */
export function augmentPromptForJsonSchema(prompt: string, schema: Record<string, unknown>): string {
  return `${prompt}

---

CRITICAL: Respond with ONLY a JSON object matching the schema below. No prose before or after the JSON. No markdown code fences. Do not use tools to write the JSON to a file. Just the raw JSON object as your final message.

Schema:
${JSON.stringify(schema, null, 2)}`;
}

/**
 * Parse an assistant reply as the structured-output JSON object, in tiers:
 *  1. the whole reply (after trimming and stripping code fences);
 *  2. from the first `{`, for a prose preamble before the object;
 *  3. jsonrepair of that region, for trailing commas, single quotes, unquoted keys or a
 *     truncated tail; gated on a `:` so prose is never coerced into an object.
 * Only a non-null, non-array object counts. `undefined` means unavailable; the engine
 * then re-asks or fails the node rather than degrading silently.
 */
export function tryParseStructuredOutput(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const cleaned = trimmed
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?\s*```\s*$/, '')
    .trim();

  const tier1 = tryJsonParseObject(cleaned);
  if (tier1 !== undefined) return tier1;

  const firstBrace = cleaned.indexOf('{');
  if (firstBrace > 0) {
    const tier2 = tryJsonParseObject(cleaned.slice(firstBrace));
    if (tier2 !== undefined) return tier2;
  }

  if (firstBrace >= 0) {
    const region = cleaned.slice(firstBrace);
    if (region.includes(':')) {
      try {
        const tier3 = tryJsonParseObject(jsonrepair(region));
        if (tier3 !== undefined) return tier3;
      } catch {
        // Irreparable: fall through to undefined.
      }
    }
  }
  return undefined;
}

function tryJsonParseObject(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
