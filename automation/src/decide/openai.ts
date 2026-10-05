import OpenAI from "openai";
import { DECISION_SCHEMA, factsMessage, parseDecision, SYSTEM_PROMPT } from "./decision";
import type { Decider } from "./provider";

// OpenAI's recommended model for new projects (developers.openai.com, October 2026).
export const DEFAULT_OPENAI_MODEL = "gpt-6-astra";

/** An OpenAI model decides with one Responses API call, held to the same strict schema. */
export function openaiDecider(options: { apiKey: string; model?: string; client?: OpenAI }): Decider {
  const model = options.model || DEFAULT_OPENAI_MODEL;
  const client = options.client ?? new OpenAI({ apiKey: options.apiKey });
  return {
    provider: "openai",
    model,
    async decide(facts) {
      const response = await client.responses.create({
        model,
        reasoning: { effort: "high" },
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: factsMessage(facts) },
        ],
        text: { format: { type: "json_schema", name: "decision", schema: DECISION_SCHEMA, strict: true } },
      });
      const served = response.model ?? model;
      if (response.status === "incomplete") return { provider: "openai", model: served, decision: null, note: "incomplete" };
      const refused = response.output.some((item) => item.type === "message" &&
        item.content.some((part) => part.type === "refusal"));
      if (refused) return { provider: "openai", model: served, decision: null, note: "refusal" };
      const decision = parseDecision(response.output_text);
      return { provider: "openai", model: served, decision, ...(decision ? {} : { note: "invalid" }) };
    },
  };
}
