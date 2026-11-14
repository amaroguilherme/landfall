// Engine errors with stable, language-neutral codes (port of engine/errors.py, SPEC section 5).
// Conformance vectors record failures as {"raises": "<code>"}; callers branch on `code`, never on
// the message text.

export const ERROR_CODES = [
  'invalid_argument', // a parameter has the wrong type or is out of range
  'invalid_rule', // a rule / indicator / config object is malformed
  'invalid_case', // a case definition cannot be turned into a case state
  'unit_mismatch', // observation unit differs from the rule unit (never converted)
  'variable_mismatch', // observation variable differs from the rule variable
  'unknown_unit', // no UCUM mapping for a unit going into a FHIR packet
  'missing_comms_table', // environment needs a light-time table and none was given
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/** Thrown for every contract violation. `code` is one of ERROR_CODES. */
export class EngineError extends Error {
  readonly code: ErrorCode
  /** The message without the `code: ` prefix. */
  readonly reason: string

  constructor(code: ErrorCode, reason: string) {
    super(`${code}: ${reason}`)
    this.name = 'EngineError'
    this.code = code
    this.reason = reason
  }
}

export function isEngineError(e: unknown): e is EngineError {
  return e instanceof EngineError
}
