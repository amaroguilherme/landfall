"""Number and time formatting that the TypeScript port can reproduce exactly.

Python's float repr, f-string rounding (round-half-even on the exact binary value), JS
`toFixed` (ties go up) and JS `String(x)` (exponent thresholds) all disagree somewhere. Every
string the engine emits is therefore built with integer arithmetic on IEEE-754 doubles,
using only operations both languages define identically (+, -, *, /, floor, sqrt).
"""

from __future__ import annotations

import math
import re
from datetime import datetime, timedelta, timezone

from .errors import EngineError

FMT_MAX_ABS = 1e15  # beyond this, integer digits are no longer exact in a double
# k = floor(|x| * 10^dp + 0.5) must stay below 2^53 so that JS `k % s` and `(k - fp) / s` on doubles
# are exact (Python does them on exact ints). Above it the two languages can print different digits.
FMT_MAX_SCALED = 9007199254740992.0  # 2^53
_EPOCH_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


def is_number(x: object) -> bool:
    """True for finite int/float. Booleans are rejected (Python bool is an int; JS boolean is not)."""
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return False
    return math.isfinite(x)


def require_number(x: object, what: str) -> float:
    if not is_number(x):
        raise EngineError("invalid_argument", f"{what} must be a finite number, got {x!r}")
    return x  # type: ignore[return-value]


def sum_lr(xs: list[float]) -> float:
    """Plain left-to-right float summation.

    Deliberately NOT the built-in sum(): since Python 3.12 sum() of floats is compensated
    (Neumaier), which a naive JS loop does not reproduce bit for bit.
    """
    acc = 0.0
    for x in xs:
        acc = acc + float(x)
    return acc


def fmt_num(x: float, dp: int = 3) -> str:
    """Format a number with at most `dp` decimals, round half away from zero, no trailing zeros.

    Algorithm (mirror exactly in TS):
        k  = floor(|x| * 10^dp + 0.5)          # IEEE double ops, then floor
        fp = k mod 10^dp ; ip = (k - fp) / 10^dp
        s  = str(ip) [+ "." + fp zero-padded to dp digits with trailing zeros stripped]
        prefix "-" when x < 0 and k != 0
    Examples: 3 -> "3", 3.4 -> "3.4", 0.1+0.2 -> "0.3", 2.0005 -> "2.001" (if the double
    is >= the tie), -0.0004 -> "0", 600.0 -> "600".
    """
    require_number(x, "fmt_num value")
    xf = float(x)
    if abs(xf) >= FMT_MAX_ABS:
        raise EngineError("invalid_argument", f"fmt_num magnitude too large: {x!r}")
    if not isinstance(dp, int) or isinstance(dp, bool) or dp < 0 or dp > 6:
        raise EngineError("invalid_argument", f"fmt_num dp must be an int in 0..6, got {dp!r}")
    scale = 10 ** dp
    if abs(xf) * float(scale) + 0.5 >= FMT_MAX_SCALED:
        raise EngineError("invalid_argument", f"fmt_num: |x| * 10^dp must be < 2^53, got {x!r} at dp {dp}")
    k = math.floor(abs(xf) * float(scale) + 0.5)
    fp = k % scale
    ip = (k - fp) // scale
    s = str(ip)
    if fp:
        s += "." + str(fp).rjust(dp, "0").rstrip("0")
    if xf < 0 and k != 0:
        s = "-" + s
    return s


def format_met(seconds: float) -> str:
    """Mission elapsed time as 'd/hh:mm:ss', the format of NASA-STD-3001 Vol 2 Appendix F F.6.1 f:

        "Time must be displayed using a 24-hour clock in the following format (Note: leading zeros
        are suppressed in day field): label dddd/hh:mm:ss (e.g., MET 57/14:08:33, or MET
        1089/13:03:01)."

    Day 0 starts at MET 0. Non-integral input is floored. The day field has no leading zeros and
    is never truncated (day 412 prints as 412, day 10000 as 10000); hours, minutes and seconds keep
    two digits. Negative MET (pre-launch) prints with a leading '-' and the absolute value. The
    same format serves day-count durations: a countdown of 11 d 05 h 59 min 51 s is '11/05:59:51'.
    """
    require_number(seconds, "format_met seconds")
    s = math.floor(seconds)
    sign = "-" if s < 0 else ""
    a = abs(s)
    days, rem = divmod(a, 86400)
    hh, rem = divmod(rem, 3600)
    mm, ss = divmod(rem, 60)
    return f"{sign}{days}/{hh:02d}:{mm:02d}:{ss:02d}"


def parse_epoch(epoch: str) -> datetime:
    """Parse a mission epoch. Only 'YYYY-MM-DDTHH:MM:SSZ' is accepted (no offsets, no fractions)."""
    if not isinstance(epoch, str) or not _EPOCH_RE.match(epoch):
        raise EngineError("invalid_argument",
                          f"mission_epoch must be 'YYYY-MM-DDTHH:MM:SSZ', got {epoch!r}")
    try:
        return datetime.strptime(epoch, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise EngineError("invalid_argument", f"mission_epoch is not a real date: {epoch!r}") from exc


def met_to_iso(t: float, mission_epoch: str) -> str:
    """MET seconds -> UTC 'YYYY-MM-DDTHH:MM:SSZ' (POSIX seconds: no leap seconds, as in JS Date).

    MET must be integral (it is integer seconds by SPEC section 2).
    """
    require_number(t, "MET")
    if float(t) != math.floor(t):
        raise EngineError("invalid_argument", f"MET must be integer seconds, got {t!r}")
    try:
        dt = parse_epoch(mission_epoch) + timedelta(seconds=int(t))
    except OverflowError as exc:  # outside years 0001-9999; JS must reject the same range
        raise EngineError("invalid_argument", f"MET {t!r} is outside years 0001-9999 UTC") from exc
    return (f"{dt.year:04d}-{dt.month:02d}-{dt.day:02d}"
            f"T{dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}Z")
