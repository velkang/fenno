import { claudeDecider } from "./claude";
import type { Decision, DecisionFacts } from "./decision";
import { openaiDecider } from "./openai";

export type Provider = "claude" | "openai";

export type DeciderResult = {
  provider: Provider;
  model: string;
  /** Null when the provider refused, was cut off, or answered outside the fixed shape. */
  decision: Decision | null;
  note?: string;
};

export interface Decider {
  provider: Provider;
  model: string;
  decide(facts: DecisionFacts): Promise<DeciderResult>;
}

/** Asks the first provider, and the second when the first fails or gives no usable answer. */
export async function decide(facts: DecisionFacts, primary: Decider, fallback?: Decider): Promise<DeciderResult> {
  let result: DeciderResult = { provider: primary.provider, model: primary.model, decision: null };
  for (const decider of fallback ? [primary, fallback] : [primary]) {
    try {
      result = await decider.decide(facts);
    } catch (error) {
      console.warn(`Automation decision from ${decider.provider} failed`, error);
      result = { provider: decider.provider, model: decider.model, decision: null, note: "error" };
    }
    if (result.decision) return result;
  }
  return result;
}

export type DeciderEnv = {
  AGENT_PROVIDER?: string;
  AGENT_FALLBACK_PROVIDER?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  AGENT_CLAUDE_MODEL?: string;
  AGENT_OPENAI_MODEL?: string;
};

function deciderFor(env: DeciderEnv, provider: string | undefined): Decider | undefined {
  if (provider === "claude" && env.ANTHROPIC_API_KEY) {
    return claudeDecider({ apiKey: env.ANTHROPIC_API_KEY, model: env.AGENT_CLAUDE_MODEL });
  }
  if (provider === "openai" && env.OPENAI_API_KEY) {
    return openaiDecider({ apiKey: env.OPENAI_API_KEY, model: env.AGENT_OPENAI_MODEL });
  }
  return undefined;
}

/** The providers set up for this Worker: `AGENT_PROVIDER` (default Claude) and an optional fallback. */
export function decidersFromEnv(env: DeciderEnv): { primary: Decider; fallback?: Decider } | null {
  const primary = deciderFor(env, env.AGENT_PROVIDER || "claude");
  if (!primary) return null;
  const fallback = env.AGENT_FALLBACK_PROVIDER && env.AGENT_FALLBACK_PROVIDER !== primary.provider
    ? deciderFor(env, env.AGENT_FALLBACK_PROVIDER) : undefined;
  return { primary, ...(fallback ? { fallback } : {}) };
}
