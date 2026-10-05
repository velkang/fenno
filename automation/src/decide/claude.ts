import Anthropic from "@anthropic-ai/sdk";
import { DECISION_SCHEMA, factsMessage, parseDecision, SYSTEM_PROMPT } from "./decision";
import type { Decider } from "./provider";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

/**
 * Claude decides with one structured call. A safety decline is retried server-side on
 * Anthropic's recommended fallback model; a decline that remains, or an answer cut off at
 * max_tokens, counts as no decision.
 */
export function claudeDecider(options: { apiKey: string; model?: string; client?: Anthropic }): Decider {
  const model = options.model || DEFAULT_CLAUDE_MODEL;
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey });
  return {
    provider: "claude",
    model,
    async decide(facts) {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        // Real money rides on this: think it through.
        output_config: { effort: "high", format: { type: "json_schema", schema: DECISION_SCHEMA } },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: factsMessage(facts) }],
      });
      const served = response.model ?? model;
      if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
        return { provider: "claude", model: served, decision: null, note: response.stop_reason };
      }
      const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
      const decision = parseDecision(text);
      return { provider: "claude", model: served, decision, ...(decision ? {} : { note: "invalid" }) };
    },
  };
}
