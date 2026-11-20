import type { PersonaSpec } from "@/agents/council/personas";

export function buildCouncilPrompt(
  persona: PersonaSpec,
  claim: { question: string; creatorPosition: string; counterPosition: string },
): string {
  return `${persona.promptBias}

You are giving your personal take, in character, on a prediction market claim.

**Claim:** ${claim.question}
**Side A (creator):** ${claim.creatorPosition}
**Side B (challenger):** ${claim.counterPosition}

Write one tight paragraph (max 90 words): which side you lean toward and your honest reasoning. Stay in character.`;
}
