import { checkPublishableText } from "@/lib/reasoning/redact";

export const UNAVAILABLE_REASONING = "(reasoning unavailable right now)";

export async function produceReasoning(
  prompt: string,
  llm: (prompt: string) => Promise<string>,
): Promise<{ reasoning: string; cacheable: boolean }> {
  try {
    const raw = (await llm(prompt)).trim();
    if (!raw) {
      return { reasoning: UNAVAILABLE_REASONING, cacheable: false };
    }
    const check = checkPublishableText(raw);
    if (!check.safe) {
      return { reasoning: UNAVAILABLE_REASONING, cacheable: false };
    }
    return { reasoning: raw, cacheable: true };
  } catch {
    return { reasoning: UNAVAILABLE_REASONING, cacheable: false };
  }
}
