"""Engine errors with stable, language-neutral codes.

The TypeScript port throws an error carrying the same `code` string. Conformance vectors
record failures as {"raises": "<code>"}, never as a Python exception class name.
"""

from __future__ import annotations

ERROR_CODES = (
    "invalid_argument",     # a parameter has the wrong type or is out of range
    "invalid_rule",         # a rule / indicator / config object is malformed
    "invalid_case",         # a case definition cannot be turned into a case state
    "unit_mismatch",        # observation unit differs from the rule unit (never converted)
    "variable_mismatch",    # observation variable differs from the rule variable
    "unknown_unit",         # no UCUM mapping for a unit going into a FHIR packet
    "missing_comms_table",  # environment needs a light-time table and none was given
)


class EngineError(ValueError):
    """Raised for every contract violation. `code` is one of ERROR_CODES."""

    def __init__(self, code: str, message: str) -> None:
        if code not in ERROR_CODES:  # pragma: no cover - programming error in the engine itself
            raise AssertionError(f"unknown engine error code {code!r}")
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
