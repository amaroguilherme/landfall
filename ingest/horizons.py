"""JPL Horizons adapter: Earth-Mars and Earth-Moon light time, and Mars solar conjunctions.

Source: JPL Horizons API (https://ssd.jpl.nasa.gov/api/horizons.api, documented at
https://ssd-api.jpl.nasa.gov/doc/horizons.html). Public, no key. Observer is the
Earth geocenter (500@399); targets are Mars (499) and the Moon (301).

Snapshots produced:

  horizons_mars_comms  predicted  daily 2026-01-01..2029-12-31: range (au, km), one-way
                                  light time (s) and Sun-Earth-Mars elongation (deg), plus
                                  solar-conjunction windows from an elongation threshold
                                  calibrated to NASA/JPL published command-moratorium dates.
  horizons_moon_comms  predicted  daily range and one-way light time for the Moon, same span.

`data` of horizons_mars_comms (the shape comms_eta reads):

  rows         [[date "YYYY-MM-DD" (00:00 UTC), range_au, range_km, one_way_light_time_s,
                 elongation_deg], ...]           (column names in data.columns)
  conjunctions [{id, start, end (ISO Z, hour-rounded), start_date, end_date, duration_days,
                 min_elongation_deg, min_elongation_date, start_before_coverage, ...}]
  calibration  threshold, per-window residuals (days), RMS, the published quotes.

Light time = range_au x (au_km / c_km_s), both constants parsed from the Horizons
header; it is cross-checked against Horizons' own 1-way light-time column.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from urllib.parse import quote, urlencode

from ingest._horizons_core import (HorizonsFormatError, ObserverTable, Window, calibrate_threshold,
                                   check_api_payload, column_unit, day_noon, days_between,
                                   find_windows, interpolate, light_time_per_au_s, match_window,
                                   parse_horizons_time, parse_observer_csv, quote_in_page,
                                   to_float)
from ingest._horizons_published import (JPL_STATED_CRITERION_DEG, JPL_STATED_CRITERION_IDS,
                                        PUBLISHED_MORATORIA)
from ingest.common import RunContext, make_snapshot, to_iso_z

ADAPTER_ID = "horizons"

API_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
API_DOC_URL = "https://ssd-api.jpl.nasa.gov/doc/horizons.html"
LANDING_URL = "https://ssd.jpl.nasa.gov/horizons/"
MANUAL_URL = "https://ssd.jpl.nasa.gov/horizons/manual.html"

CENTER = "500@399"            # Earth geocenter
MARS, MOON = "499", "301"
SPAN = ("2026-01-01", "2029-12-31")
# Second request: the calibration conjunctions (2013-2023) and the December 2025 start of
# the window that straddles 2026-01-01.
CALIBRATION_SPAN = ("2012-12-01", "2025-12-31")

# The task brief's figure; our value is derived from the Horizons header and must round to it.
LIGHT_TIME_PER_AU_BRIEF_S = 499.004784

LICENSE = ("No data license is stated in the Horizons manual or API documentation (checked "
           "2026-11-14); those pages link the JPL Image Use Policy "
           "(https://www.jpl.nasa.gov/jpl-image-use-policy). Horizons was developed at JPL "
           "(Caltech) under contract with NASA. Cited per the manual's 'References for the "
           "Horizons system'.")


# ---------------------------------------------------------------- requests
def horizons_params(command: str, start: str, stop: str, quantities: str) -> dict:
    return {
        "format": "json", "COMMAND": f"'{command}'", "OBJ_DATA": "'NO'", "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'OBSERVER'", "CENTER": f"'{CENTER}'", "START_TIME": f"'{start}'",
        "STOP_TIME": f"'{stop}'", "STEP_SIZE": "'1 d'", "QUANTITIES": f"'{quantities}'",
        "CSV_FORMAT": "'YES'",
    }


def access_url(params: dict) -> str:
    return API_URL + "?" + urlencode(params, quote_via=quote, safe="")


def fetch_table(ctx: RunContext, params: dict) -> tuple[ObserverTable, dict]:
    payload = ctx.fetch_json(API_URL, params)
    table = parse_observer_csv(check_api_payload(payload))
    return table, payload.get("signature") or {}


# ---------------------------------------------------------------- table -> series
def require_units(table: ObserverTable, need_elongation: bool) -> None:
    lt_unit = column_unit(table.column_notes, "'1-way_down_LT,'")
    rng_unit = column_unit(table.column_notes, "'delta,")
    if lt_unit != "MINUTES":
        raise HorizonsFormatError(f"1-way light time unit is {lt_unit!r}, expected MINUTES")
    if rng_unit is None or not rng_unit.startswith("AU"):
        raise HorizonsFormatError(f"range unit is {rng_unit!r}, expected AU")
    if need_elongation:
        el_unit = column_unit(table.column_notes, "'S-O-T,/r,'")
        if el_unit != "DEGREES":
            raise HorizonsFormatError(f"elongation unit is {el_unit!r}, expected DEGREES")
    for k in ("au_km", "c_km_s"):
        if k not in table.header:
            raise HorizonsFormatError("Horizons header lacks the 'Units conversion' au / c line")


def table_series(table: ObserverTable, need_elongation: bool) -> list[dict]:
    """Rows as dicts: t, range_au, deldot_km_s, hz_lt_s and (optionally) elong_deg."""
    require_units(table, need_elongation)
    i_t, i_r, i_rr = table.date_col(), table.col("delta"), table.col("deldot")
    i_lt = table.col("1-way_down_LT")
    i_el = table.col("S-O-T") if need_elongation else None
    out = []
    for rec in table.records:
        t = parse_horizons_time(rec[i_t])
        row = {"t": t, "range_au": to_float(rec[i_r], f"delta at {rec[i_t]}"),
               "deldot_km_s": to_float(rec[i_rr], f"deldot at {rec[i_t]}"),
               "hz_lt_s": to_float(rec[i_lt], f"1-way LT at {rec[i_t]}") * 60.0}
        if i_el is not None:
            row["elong_deg"] = to_float(rec[i_el], f"S-O-T at {rec[i_t]}")
        out.append(row)
    for a, b in zip(out, out[1:]):
        if b["t"] - a["t"] != timedelta(days=1):
            raise HorizonsFormatError(f"non-daily step between {a['t']} and {b['t']}")
    return out


def light_time_check(series: list[dict], tau: float) -> dict:
    """Our range-derived light time vs Horizons' own 1-way down-leg light time."""
    diffs = [(r["range_au"] * tau - r["hz_lt_s"], r["t"]) for r in series]
    worst = max(diffs, key=lambda x: abs(x[0]))
    return {"max_abs_diff_s": float(f"{abs(worst[0]):.3g}"),
            "at": worst[1].date().isoformat(),
            "mean_diff_s": float(f"{sum(d for d, _ in diffs) / len(diffs):.3g}"),
            "n": len(diffs),
            "resolution_note": "Horizons prints light time in minutes with 8 decimals "
                               "(6e-7 s), so agreement at ~3e-7 s is agreement to its last digit."}


def uplink_downlink_bound_s(series: list[dict], tau: float, c_km_s: float) -> float:
    """Upper bound on |up-leg - down-leg| light time: max |range-rate| x light time / c."""
    return max(abs(r["deldot_km_s"]) * r["range_au"] * tau / c_km_s for r in series)


def hour_round(t: datetime) -> datetime:
    return (t + timedelta(minutes=30)).replace(minute=0, second=0, microsecond=0)


def window_record(w: Window, threshold: float, coverage_start: datetime, rms: float) -> dict:
    s, e = hour_round(w.start), hour_round(w.end)
    return {
        "id": f"mars_conjunction_{w.min_at:%Y_%m}",
        "start": to_iso_z(s), "end": to_iso_z(e),
        "start_date": s.date().isoformat(), "end_date": e.date().isoformat(),
        "duration_days": round(days_between(w.end, w.start), 2),
        "min_elongation_deg": w.min_value,
        "min_elongation_date": w.min_at.date().isoformat(),
        "min_elongation_basis": "smallest of the daily 00:00 UTC samples (not a refined minimum)",
        "threshold_deg": threshold,
        "start_before_coverage": w.start < coverage_start,
        "edge_uncertainty_days_rms": round(rms, 2),
        "basis": "derived: Sun-Earth-Mars elongation below the calibrated threshold "
                 "(edges linearly interpolated between daily samples, rounded to the hour)",
    }


# ---------------------------------------------------------------- calibration
HAND_VERIFIED_ON = "2026-11-14"
_MIN_PAGE_CHARS = 2000   # shorter bodies are bot challenges or error stubs, not the article


def verify_quotes(ctx: RunContext) -> dict[str, dict]:
    """Re-fetch each NASA/JPL page and look for its quote.

    A page that is served but no longer carries its quote is a hard error (a human must
    re-read it). A page that cannot be fetched (offline, or jpl.nasa.gov answering the
    scripted client with HTTP 403) is reported as not re-verified, never as verified.
    """
    status: dict[str, dict] = {}
    pages: dict[str, tuple[str | None, str | None]] = {}
    for p in PUBLISHED_MORATORIA:
        url = p["url"]
        if url not in pages:
            try:
                raw = ctx.fetch_text(url, retries=1)   # a 403 is deterministic; do not wait
                pages[url] = (raw, None) if len(raw) >= _MIN_PAGE_CHARS else (
                    None, f"page body only {len(raw)} chars (bot challenge or error stub)")
            except RuntimeError as exc:   # offline and uncached, HTTP 403, or the site is down
                pages[url] = (None, str(exc)[:240])
        raw, why = pages[url]
        if raw is None:
            status[p["id"]] = {"quote_verified_this_build": False,
                               "quote_verification_note": f"not re-fetched this build: {why}. "
                               f"Quote read by hand in the raw page HTML on {HAND_VERIFIED_ON}."}
            continue
        if not quote_in_page(p["quote"], raw):
            raise HorizonsFormatError(
                f"published moratorium quote for {p['id']} no longer found at {url}; "
                "re-read the page before rebuilding")
        status[p["id"]] = {"quote_verified_this_build": True}
    return status


def build_calibration(elong: list[tuple[datetime, float]], quote_status: dict) -> dict:
    used = [p for p in PUBLISHED_MORATORIA if p["used_in_calibration"]]
    best = calibrate_threshold(elong, used)
    th = best["threshold"]
    windows = find_windows(elong, th)

    def published_entry(p: dict, res: dict | None) -> dict:
        w = res["window"] if res else match_window(windows, p["start"], p["end"])
        e = {k: p[k] for k in ("id", "conjunction", "scope", "used_in_calibration", "quote",
                               "doc", "publisher", "published", "url")}
        e["start_date"], e["end_date"] = p["start"].isoformat(), p["end"].isoformat()
        if "exclusion_reason" in p:
            e["exclusion_reason"] = p["exclusion_reason"]
        e.update(quote_status.get(p["id"], {}))
        # Threshold-free view: the elongation on the published first and last day (12:00 UTC).
        try:
            e["elongation_on_start_day_deg"] = round(interpolate(elong, day_noon(p["start"])), 3)
            e["elongation_on_end_day_deg"] = round(interpolate(elong, day_noon(p["end"])), 3)
        except ValueError:
            pass
        if w is not None and w.start is not None and w.end is not None:
            e["computed_start"] = to_iso_z(hour_round(w.start))
            e["computed_end"] = to_iso_z(hour_round(w.end))
            e["start_residual_days"] = round(days_between(w.start, day_noon(p["start"])), 2)
            e["end_residual_days"] = round(days_between(w.end, day_noon(p["end"])), 2)
            e["min_elongation_deg"] = w.min_value
            e["min_elongation_date"] = w.min_at.date().isoformat()
        return e

    by_id = {r["id"]: r for r in best["residuals"]}
    entries = [published_entry(p, by_id.get(p["id"])) for p in PUBLISHED_MORATORIA]
    n_used = len(used)
    return {
        "threshold_deg": {
            "value": th,
            "chip": "derived",
            "source": {
                "kind": "derived",
                "from": [p["id"] for p in used] + ["horizons Sun-Earth-Mars elongation (S-O-T), "
                                                   f"daily {CALIBRATION_SPAN[0]}..{CALIBRATION_SPAN[1]}"],
                "arithmetic": (
                    f"threshold = argmin over {{{best['grid']['lo']:.2f}, "
                    f"{best['grid']['lo'] + best['grid']['step']:.2f}, ..., "
                    f"{best['grid']['hi']:.2f}}} deg of the sum, over the {2 * n_used} start and "
                    f"end dates of {n_used} NASA/JPL published moratoria, of (computed edge - "
                    "published day at 12:00 UTC)^2 in days^2; a computed edge is the "
                    "linearly interpolated time the daily elongation crosses the threshold"),
            },
        },
        "residual_rms_days": round(best["rms_days"], 2),
        "residual_max_abs_days": round(best["max_abs_days"], 2),
        "residual_mean_days": round(best["mean_days"], 2),
        "n_edges": best["n_edges"],
        "sign_convention": "residual = computed edge - published day (12:00 UTC); negative = "
                           "the model opens or closes the window earlier than NASA did",
        "date_convention": "Published dates carry no time zone or time of day; each is taken as "
                           "a UTC calendar day and compared at its midpoint, so |residual| <= 0.5 "
                           "means the computed edge falls on the published day.",
        "cross_check": {
            "jpl_stated_criterion_deg": JPL_STATED_CRITERION_DEG,
            "jpl_stated_in": JPL_STATED_CRITERION_IDS,
            "difference_deg": round(th - JPL_STATED_CRITERION_DEG, 2),
            "note": "JPL itself printed 'two degrees' (2013 and 2015 releases). It is reported "
                    "here as an independent check, not used to set the threshold.",
        },
        "published": entries,
    }


def calibration_series(elong: list[tuple[datetime, float]]) -> list[list]:
    """The elongation samples around each published window (lets a reader redo the fit)."""
    keep = []
    for t, v in elong:
        for p in PUBLISHED_MORATORIA:
            lo = datetime(p["start"].year, p["start"].month, p["start"].day) - timedelta(days=10)
            hi = datetime(p["end"].year, p["end"].month, p["end"].day) + timedelta(days=10)
            if lo <= t <= hi:
                keep.append([t.date().isoformat(), v])
                break
    return keep


# ---------------------------------------------------------------- snapshots
def _citation(signature: dict, retrieved_at: str, what: str) -> str:
    d = datetime.strptime(retrieved_at[:10], "%Y-%m-%d")
    return (f"Giorgini, JD and JPL Solar System Dynamics Group, NASA/JPL Horizons On-Line "
            f"Ephemeris System, <{LANDING_URL}>, data retrieved {d:%Y-%b-%d}. {what}. "
            f"Accessed through the Horizons API ({API_URL}), signature "
            f"\"{signature.get('source', '?')}\" version {signature.get('version', '?')}.")


def _horizons_block(table: ObserverTable, signature: dict, requests: list[dict]) -> dict:
    h = table.header
    return {
        "api_signature": signature,
        "api_doc_url": API_DOC_URL,
        "target": h.get("target_name"), "target_ephemeris": h.get("target_ephemeris"),
        "center": h.get("center_name"), "center_ephemeris": h.get("center_ephemeris"),
        "center_site": h.get("center_site"), "generated": h.get("generated"),
        "units_conversion": h.get("units_conversion_text"),
        "requests": requests,
    }


def _tau_constant(h: dict, tau: float) -> dict:
    return {
        "value": round(tau, 9), "unit": "s/au", "chip": "derived",
        "source": {"kind": "derived", "from": ["horizons header: " + h["units_conversion_text"]],
                   "arithmetic": f"{h['au_km']:.3f} km / {h['c_km_s']:.3f} km/s = {tau:.9f} s"},
    }


def build_mars(ctx: RunContext) -> dict:
    p_main = horizons_params(MARS, *SPAN, "20,21,23")
    p_cal = horizons_params(MARS, *CALIBRATION_SPAN, "20,21,23")
    t_main, sig = fetch_table(ctx, p_main)
    t_cal, sig_cal = fetch_table(ctx, p_cal)
    main = table_series(t_main, need_elongation=True)
    cal = table_series(t_cal, need_elongation=True)
    h = t_main.header
    if (h.get("au_km"), h.get("c_km_s")) != (t_cal.header.get("au_km"), t_cal.header.get("c_km_s")):
        raise HorizonsFormatError("au / c differ between the two Horizons requests")
    tau = light_time_per_au_s(h["au_km"], h["c_km_s"])
    if round(tau, 6) != LIGHT_TIME_PER_AU_BRIEF_S:
        raise HorizonsFormatError(f"au/c = {tau!r} s does not round to {LIGHT_TIME_PER_AU_BRIEF_S}")
    if cal[-1]["t"] + timedelta(days=1) != main[0]["t"]:
        raise HorizonsFormatError("calibration and main series are not contiguous")

    merged = [(r["t"], r["elong_deg"]) for r in cal + main]
    quote_status = verify_quotes(ctx)
    calib = build_calibration(merged, quote_status)
    th = calib["threshold_deg"]["value"]
    cov_start, cov_stop = main[0]["t"], main[-1]["t"]
    conj = [window_record(w, th, cov_start, calib["residual_rms_days"])
            for w in find_windows(merged, th)
            if w.start is not None and w.end is not None and w.end >= cov_start
            and w.start <= cov_stop]
    open_end = [w for w in find_windows(merged, th) if w.end is None]
    if open_end:
        raise HorizonsFormatError("a conjunction window is still open at 2029-12-31")

    rows = [[r["t"].date().isoformat(), r["range_au"], round(r["range_au"] * h["au_km"]),
             round(r["range_au"] * tau, 3), r["elong_deg"]] for r in main]
    lo = min(main, key=lambda r: r["range_au"])
    hi = max(main, key=lambda r: r["range_au"])
    lt_check = light_time_check(cal + main, tau)
    updown = uplink_downlink_bound_s(main, tau, h["c_km_s"])

    requests = [{"purpose": "comms series", "span": list(SPAN), "url": access_url(p_main)},
                {"purpose": "calibration (2013-2023 conjunctions) and the Dec 2025 start of the "
                            "window that straddles 2026-01-01",
                 "span": list(CALIBRATION_SPAN), "url": access_url(p_cal)}]
    data = {
        "observer": {"code": CENTER, "label": "Earth geocenter"},
        "target": {"code": MARS, "label": "Mars"},
        "horizons": _horizons_block(t_main, sig, requests),
        "constants": {
            "light_time_per_au_s": _tau_constant(h, tau),
            "au_km": {"value": h["au_km"], "unit": "km",
                      "basis": "as printed in the Horizons header"},
        },
        "columns": ["date", "range_au", "range_km", "one_way_light_time_s", "elongation_deg"],
        "units": ["UTC date, sample at 00:00", "au", "km", "s", "deg"],
        "column_basis": {
            "range_au": "Horizons 'delta' (apparent range, light-time aberrated), verbatim",
            "range_km": "derived: range_au x au_km, rounded to 1 km",
            "one_way_light_time_s": "derived: range_au x light_time_per_au_s, rounded to 1 ms",
            "elongation_deg": "Horizons 'S-O-T' (Sun-Observer-Target apparent solar elongation), "
                              "verbatim",
        },
        "rows": rows,
        "summary": {
            "min_range": {"date": lo["t"].date().isoformat(), "range_au": lo["range_au"],
                          "one_way_light_time_s": round(lo["range_au"] * tau, 1),
                          "one_way_light_time_min": round(lo["range_au"] * tau / 60, 2)},
            "max_range": {"date": hi["t"].date().isoformat(), "range_au": hi["range_au"],
                          "one_way_light_time_s": round(hi["range_au"] * tau, 1),
                          "one_way_light_time_min": round(hi["range_au"] * tau / 60, 2)},
        },
        "light_time_cross_check": lt_check,
        "uplink_vs_downlink_bound_s": {
            "value": round(updown, 3), "chip": "derived",
            "source": {"kind": "derived", "from": ["horizons deldot", "one_way_light_time_s"],
                       "arithmetic": "max over rows of |deldot| x one-way light time / c"},
        },
        "conjunctions": conj,
        "calibration": calib,
        "calibration_series": {"columns": ["date", "elongation_deg"],
                               "note": "daily 00:00 UTC samples within 10 days of each "
                                       "published window",
                               "rows": calibration_series(merged)},
    }
    caveats = [
        "Ephemeris output, not a measurement: JPL Horizons observer table for Mars (499) seen "
        "from the Earth geocenter (500@399), one sample per day at 00:00 UTC. Interpolate "
        "linearly between days.",
        "Range is Earth-center to Mars-center. A ground antenna or a crew on the surface differs "
        "by at most about one Earth radius plus one Mars radius (about 0.03 light-seconds).",
        "One-way light time is geometric (range / c with the au and c printed by Horizons). "
        "Relativistic (Shapiro) and solar-plasma delays near conjunction are not modelled; both "
        "are well under one second.",
        f"Up-leg and down-leg light times differ by at most {updown:.2f} s over this span "
        "(range-rate bound in data.uplink_vs_downlink_bound_s); the table is the down-leg.",
        "Conjunction windows are a model: the days on which the Sun-Earth-Mars elongation is "
        f"below one threshold ({th:.2f} deg) fitted to NASA/JPL published command-moratorium "
        f"dates (RMS edge residual {calib['residual_rms_days']:.2f} d, worst "
        f"{calib['residual_max_abs_days']:.2f} d). Real moratoria are operational decisions; "
        "NASA wrote in 2021 that a few missions extend theirs 'a day or two in either direction'.",
        "Published moratorium dates carry no time zone; they are compared as UTC calendar days.",
        "The calibration years (2012-12-01..2025-12-31) come from a second Horizons request; it "
        "also supplies the December 2025 start of the window that straddles 2026-01-01.",
        "For the January 2026 conjunction NASA published a no-contact span (Dec. 29 - Jan. 16), "
        "not a command-moratorium span; it is shown as an out-of-sample comparison and is not "
        "part of the fit.",
        "Horizons API documentation states version 1.3 (2025 June) but the API signature "
        f"returned version {sig.get('version', '?')}; the parser keys on column names and the "
        "$$SOE/$$EOE markers and fails loudly if the format changes.",
        "A planetary ephemeris does not go stale on a clock (stale_after is null): the values are "
        "valid until coverage.stop. Past dates in the span are ephemeris reconstructions, not "
        "telemetry.",
    ]
    n_ok = sum(1 for v in quote_status.values() if v.get("quote_verified_this_build"))
    if n_ok < len(PUBLISHED_MORATORIA):
        caveats.append(
            f"{n_ok} of {len(PUBLISHED_MORATORIA)} published moratorium quotes were re-verified "
            "against the live page in this build; the others could not be fetched by the "
            "scripted client (see calibration.published[].quote_verification_note) and rest on "
            f"a reading of the raw page HTML on {HAND_VERIFIED_ON}.")
    if sig_cal != sig:
        caveats.append(f"The two requests returned different API signatures: {sig} vs {sig_cal}.")
    return make_snapshot(
        id="horizons_mars_comms", adapter=ADAPTER_ID,
        title="Earth-Mars light time and solar conjunction windows, 2026-2029 (JPL Horizons)",
        source={
            "publisher": "NASA Jet Propulsion Laboratory, Solar System Dynamics Group",
            "name": "JPL Horizons On-Line Ephemeris System: observer table, Mars (499) from Earth "
                    "geocenter (500@399); conjunction threshold calibrated to NASA/JPL "
                    "command-moratorium announcements",
            "url": LANDING_URL,
            "access_urls": [access_url(p_main), access_url(p_cal)]
                           + sorted({p["url"] for p in PUBLISHED_MORATORIA}),
            "license": LICENSE,
            "citation": _citation(sig, ctx.retrieved_at,
                                  "Observer table, target Mars (499), center Earth geocenter "
                                  "(500@399), quantities 20, 21, 23, daily"),
        },
        retrieved_at=ctx.retrieved_at,
        coverage={"start": to_iso_z(cov_start), "stop": to_iso_z(cov_stop), "cadence": "P1D"},
        freshness={"kind": "prediction", "stale_after": None},
        provenance="predicted", caveats=caveats, data=data)


def build_moon(ctx: RunContext) -> dict:
    params = horizons_params(MOON, *SPAN, "20,21")
    table, sig = fetch_table(ctx, params)
    series = table_series(table, need_elongation=False)
    h = table.header
    tau = light_time_per_au_s(h["au_km"], h["c_km_s"])
    rows = [[r["t"].date().isoformat(), r["range_au"], round(r["range_au"] * h["au_km"]),
             round(r["range_au"] * tau, 4)] for r in series]
    lo = min(series, key=lambda r: r["range_au"])
    hi = max(series, key=lambda r: r["range_au"])
    data = {
        "observer": {"code": CENTER, "label": "Earth geocenter"},
        "target": {"code": MOON, "label": "Moon"},
        "horizons": _horizons_block(table, sig, [{"purpose": "comms series", "span": list(SPAN),
                                                  "url": access_url(params)}]),
        "constants": {"light_time_per_au_s": _tau_constant(h, tau),
                      "au_km": {"value": h["au_km"], "unit": "km",
                                "basis": "as printed in the Horizons header"}},
        "columns": ["date", "range_au", "range_km", "one_way_light_time_s"],
        "units": ["UTC date, sample at 00:00", "au", "km", "s"],
        "column_basis": {
            "range_au": "Horizons 'delta' (apparent range, light-time aberrated), verbatim",
            "range_km": "derived: range_au x au_km, rounded to 1 km",
            "one_way_light_time_s": "derived: range_au x light_time_per_au_s, rounded to 0.1 ms",
        },
        "rows": rows,
        "summary": {
            "min_range": {"date": lo["t"].date().isoformat(),
                          "range_km": round(lo["range_au"] * h["au_km"]),
                          "one_way_light_time_s": round(lo["range_au"] * tau, 3)},
            "max_range": {"date": hi["t"].date().isoformat(),
                          "range_km": round(hi["range_au"] * h["au_km"]),
                          "one_way_light_time_s": round(hi["range_au"] * tau, 3)},
        },
        "light_time_cross_check": light_time_check(series, tau),
        "conjunctions": [],
        "conjunctions_note": "None by construction: the Moon is never behind the Sun as seen "
                             "from Earth. Sun-in-antenna-beam noise near new Moon is not modelled.",
    }
    caveats = [
        "Ephemeris output, not a measurement: JPL Horizons observer table for the Moon (301) from "
        "the Earth geocenter (500@399), one sample per day at 00:00 UTC.",
        "Range is Earth-center to Moon-center; a ground antenna or a lunar-surface crew differs "
        "by at most about one Earth radius plus one Moon radius (about 0.03 light-seconds).",
        "Daily samples under-resolve the monthly perigee/apogee cycle only slightly; interpolate "
        "linearly between days.",
        "Light time is geometric (range / c); relay geometry (e.g. a lunar far-side relay) is "
        "not modelled.",
        "A planetary ephemeris does not go stale on a clock (stale_after is null): the values are "
        "valid until coverage.stop.",
    ]
    return make_snapshot(
        id="horizons_moon_comms", adapter=ADAPTER_ID,
        title="Earth-Moon light time, 2026-2029 (JPL Horizons)",
        source={
            "publisher": "NASA Jet Propulsion Laboratory, Solar System Dynamics Group",
            "name": "JPL Horizons On-Line Ephemeris System: observer table, Moon (301) from Earth "
                    "geocenter (500@399)",
            "url": LANDING_URL,
            "access_urls": [access_url(params)],
            "license": LICENSE,
            "citation": _citation(sig, ctx.retrieved_at,
                                  "Observer table, target Moon (301), center Earth geocenter "
                                  "(500@399), quantities 20, 21, daily"),
        },
        retrieved_at=ctx.retrieved_at,
        coverage={"start": to_iso_z(series[0]["t"]), "stop": to_iso_z(series[-1]["t"]),
                  "cadence": "P1D"},
        freshness={"kind": "prediction", "stale_after": None},
        provenance="predicted", caveats=caveats, data=data)


def run(ctx: RunContext) -> list[dict]:
    return [build_mars(ctx), build_moon(ctx)]
