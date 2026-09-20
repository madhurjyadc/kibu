/**
 * Per-million-token rates, used to enforce the per-task spending limit.
 * These are Anthropic first-party API rates; a model we do not know about is
 * costed pessimistically so an unknown model can never slip past the limit.
 */
export interface Rate {
  inputPerMTok: number
  outputPerMTok: number
}

const RATES: Record<string, Rate> = {
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50 }
}

const UNKNOWN_MODEL_RATE: Rate = { inputPerMTok: 15, outputPerMTok: 75 }

export function rateFor(model: string): Rate {
  return RATES[model] ?? UNKNOWN_MODEL_RATE
}

export function costOf(model: string, inputTokens: number, outputTokens: number): number {
  const rate = rateFor(model)
  return (inputTokens * rate.inputPerMTok + outputTokens * rate.outputPerMTok) / 1_000_000
}
