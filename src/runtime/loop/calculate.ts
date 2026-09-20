/**
 * A calculator with no model behind it.
 *
 * "54/30" is not a task and must never reach a planner: it is arithmetic, and
 * arithmetic is the one thing a launcher can answer perfectly, instantly, for
 * free. Deliberately not `eval` — only digits, the four operators, parentheses
 * and a percent form are accepted, and anything else returns null rather than
 * being executed. A launcher that runs arbitrary typed text as code is a
 * liability.
 */
export function evaluateArithmetic(input: string): number | null {
  const normalized = input
    .toLowerCase()
    .replace(/,/g, '')
    .replace(/(\d+(?:\.\d+)?)\s*%\s*of\s*/g, '($1/100)*')
    .replace(/\s+/g, '')
  if (!/^[0-9+\-*/().]+$/.test(normalized) || !/\d/.test(normalized)) return null

  const tokens = normalized.match(/\d+(?:\.\d+)?|[+\-*/()]/g)
  if (!tokens) return null
  let pos = 0
  const peek = (): string | undefined => tokens[pos]

  const expr = (): number | null => {
    let left = term()
    if (left === null) return null
    while (peek() === '+' || peek() === '-') {
      const op = tokens[pos++]!
      const right = term()
      if (right === null) return null
      left = op === '+' ? left + right : left - right
    }
    return left
  }
  const term = (): number | null => {
    let left = factor()
    if (left === null) return null
    while (peek() === '*' || peek() === '/') {
      const op = tokens[pos++]!
      const right = factor()
      if (right === null) return null
      if (op === '/' && right === 0) return null
      left = op === '*' ? left * right : left / right
    }
    return left
  }
  const factor = (): number | null => {
    const t = peek()
    if (t === undefined) return null
    if (t === '-') {
      pos++
      const v = factor()
      return v === null ? null : -v
    }
    if (t === '(') {
      pos++
      const v = expr()
      if (v === null || tokens[pos] !== ')') return null
      pos++
      return v
    }
    if (/^\d/.test(t)) {
      pos++
      return Number(t)
    }
    return null
  }

  const value = expr()
  if (value === null || pos !== tokens.length || !Number.isFinite(value)) return null
  return Math.round(value * 1e10) / 1e10
}
