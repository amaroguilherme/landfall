"""LANDFALL reference engine (Python stdlib only). The contract is engine/SPEC.md.

Pure functions, JSON-serialisable dicts in and out. The TypeScript runtime mirrors this API and
is checked against the conformance vectors in engine/tests/vectors/.
"""

from .cases import EVENTS, STATES, case_reduce, new_case
from .comms import comms_eta
from .errors import ERROR_CODES, EngineError
from .fmt import fmt_num, format_met, met_to_iso
from .loader import (get_case, get_environment, get_indicator, get_rule, load_rules,
                     load_snapshot, trigger_lookup)
from .packet import PRIVATE_VARIABLES, build_ground_packet, consent_allows
from .rci import chance_rate, evaluate_personal, expected_false_alarms, min_detectable_change, rci
from .tdist import t_cdf, t_critical, t_quantile
from .thresholds import NOAA_S_THRESHOLDS_PFU, SEVERITIES, STATUSES, evaluate_rule, s_level

__all__ = [
    "ERROR_CODES", "EVENTS", "EngineError", "NOAA_S_THRESHOLDS_PFU", "PRIVATE_VARIABLES",
    "SEVERITIES", "STATES", "STATUSES", "build_ground_packet", "case_reduce", "chance_rate", "comms_eta",
    "consent_allows", "evaluate_personal", "evaluate_rule", "expected_false_alarms", "fmt_num",
    "format_met", "get_case", "get_environment", "get_indicator", "get_rule", "load_rules",
    "load_snapshot", "met_to_iso", "min_detectable_change", "new_case", "rci", "s_level", "t_cdf", "t_critical",
    "t_quantile", "trigger_lookup",
]
