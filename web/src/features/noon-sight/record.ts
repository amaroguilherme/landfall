// Pure helpers for the Noon Sight: reading the simulated crew record, the streak and weekly
// logbook completeness (the sober gamification), and turning the crewmember's answers into
// SPEC section 4 observations. No React; tested in record.test.ts.
import type { CrewId, Observation, ObservationSource } from '../../app/vocab'
import type { PvtScore } from './pvt'

const DAY_S = 86_400
export const metDayOf = (t: number): number => Math.floor(t / DAY_S)

// ---------------------------------------------------------------------------------------------
// sim_crew snapshot (shape read from web/public/data/sim_crew.json, ingest/sim_crew.py)
// ---------------------------------------------------------------------------------------------

export interface SimSeries {
  unit: string
  source: string
  t?: number[]
  start_t?: number
  step_s?: number
  v: Array<number | null>
}

export interface SimCrewMember {
  crew_id: CrewId
  role: string
  series: Record<string, SimSeries>
  sleep_episodes?: { days: [number, number]; v: Array<[number, number] | null> }
}

export interface SimCrewData {
  met: { baseline_days: [number, number]; now_met_s: number; first_day: number; last_day: number }
  variables: Record<string, { label?: string; definition?: string; cadence?: string }>
  crew: SimCrewMember[]
}

export interface Point {
  t: number
  v: number
}

/** Expand a sim series into points, skipping nulls (a gap is a gap, never a zero). */
export function seriesPoints(s: SimSeries | undefined): Point[] {
  if (!s || !Array.isArray(s.v)) return []
  const out: Point[] = []
  for (let i = 0; i < s.v.length; i++) {
    const v = s.v[i]
    const t = s.t ? s.t[i] : s.start_t !== undefined && s.step_s !== undefined ? s.start_t + i * s.step_s : undefined
    if (typeof v === 'number' && Number.isFinite(v) && typeof t === 'number') out.push({ t, v })
  }
  return out
}

export function simMember(data: SimCrewData | null | undefined, crew: CrewId): SimCrewMember | undefined {
  return data?.crew?.find((c) => c.crew_id === crew)
}

/** Simulated observations of one crewmember for the given variables, with t <= now. */
export function simObservations(member: SimCrewMember | undefined, variables: readonly string[], now: number): Observation[] {
  if (!member) return []
  const out: Observation[] = []
  for (const variable of variables) {
    const s = member.series[variable]
    if (!s) continue
    for (const p of seriesPoints(s)) {
      if (p.t > now) continue
      out.push({
        crew_id: member.crew_id,
        variable,
        value: p.v,
        unit: s.unit,
        t: p.t,
        source: s.source as ObservationSource,
        provenance: 'simulated',
      })
    }
  }
  return out
}

/** Mean of the values whose MET day falls in [firstDay, lastDay]; plain left-to-right sum. */
export function baselineMean(points: readonly Point[], firstDay: number, lastDay: number): { mean: number | null; n: number } {
  let sum = 0
  let n = 0
  for (const p of points) {
    const d = metDayOf(p.t)
    if (d < firstDay || d > lastDay) continue
    sum += p.v
    n += 1
  }
  return { mean: n > 0 ? sum / n : null, n }
}

/** Latest point with t <= now. */
export function latestAtOrBefore(points: readonly Point[], now: number): Point | null {
  let best: Point | null = null
  for (const p of points) if (p.t <= now && (!best || p.t > best.t)) best = p
  return best
}

export interface SleepNight {
  durationH: number
  t: number
  onset: number | null
  offset: number | null
  midpointShiftH: number | null
}

/** Last night's main sleep episode from band actigraphy (simulated), or null. */
export function lastNight(member: SimCrewMember | undefined, now: number): SleepNight | null {
  if (!member) return null
  const dur = latestAtOrBefore(seriesPoints(member.series.sleep_duration), now)
  if (!dur) return null
  const mid = seriesPoints(member.series.sleep_midpoint_shift).find((p) => p.t === dur.t) ?? null
  let onset: number | null = null
  let offset: number | null = null
  const ep = member.sleep_episodes
  if (ep && Array.isArray(ep.v)) {
    for (const pair of ep.v) {
      if (pair && pair[1] === dur.t) {
        onset = pair[0]
        offset = pair[1]
      }
    }
  }
  return { durationH: dur.v, t: dur.t, onset, offset, midpointShiftH: mid ? mid.v : null }
}

// ---------------------------------------------------------------------------------------------
// Streak and weekly completeness (sober gamification: one number, no points, no leaderboard)
// ---------------------------------------------------------------------------------------------

export interface Fix {
  t: number
  origin: 'simulated' | 'session'
}

/**
 * Fixes of one crewmember: the simulated record's daily 12:00 check-in (sim_crew mood series,
 * cadence "daily at the 12:00 MET check-in (Noon Sight)"; only its time is used, never the
 * value) plus the Noon Sights completed in this session.
 */
export function collectFixes(simCheckins: readonly Point[], sessionTimes: readonly number[], now: number): Fix[] {
  const out: Fix[] = []
  for (const p of simCheckins) if (p.t <= now) out.push({ t: p.t, origin: 'simulated' })
  for (const t of sessionTimes) if (t <= now) out.push({ t, origin: 'session' })
  return out.sort((a, b) => a.t - b.t)
}

export interface Streak {
  /** Consecutive MET days with at least one fix, ending today (or yesterday if today is open). */
  length: number
  firstDay: number | null
  lastDay: number | null
  todayDone: boolean
  /** Today's fixes, oldest first. */
  today: Fix[]
}

export function computeStreak(fixes: readonly Fix[], today: number): Streak {
  const days = new Set(fixes.map((f) => metDayOf(f.t)))
  const todayDone = days.has(today)
  let d = todayDone ? today : today - 1
  let length = 0
  while (days.has(d)) {
    length += 1
    d -= 1
  }
  return {
    length,
    firstDay: length > 0 ? d + 1 : null,
    lastDay: length > 0 ? (todayDone ? today : today - 1) : null,
    todayDone,
    today: fixes.filter((f) => metDayOf(f.t) === today),
  }
}

/**
 * The daily logbook entries that count towards completeness. Mood is deliberately NOT one of
 * them: it is private, and skipping it must never cost the crewmember anything.
 */
export const DAILY_ENTRIES = [
  { id: 'pvt', variable: 'pvt_lapses', label: 'PVT-B' },
  { id: 'sleep', variable: 'sleep_duration', label: 'Sleep (band)' },
  { id: 'fluid', variable: 'fluid_intake_24h', label: 'Fluid intake' },
  { id: 'urine', variable: 'urine_volume_24h', label: 'Urine output' },
] as const
export type DailyEntryId = (typeof DAILY_ENTRIES)[number]['id']

export interface DayCompleteness {
  day: number
  entries: Record<DailyEntryId, boolean>
  logged: number
}

export interface WeekCompleteness {
  days: DayCompleteness[]
  logged: number
  expected: number
}

/** The last 7 MET days (today included): which daily entries were logged, from any source. */
export function weekCompleteness(observations: readonly Observation[], crew: CrewId, today: number, now: number): WeekCompleteness {
  const seen = new Set<string>()
  for (const o of observations) {
    if (o.crew_id !== crew || o.t > now) continue
    seen.add(`${metDayOf(o.t)}|${o.variable}`)
  }
  const days: DayCompleteness[] = []
  let logged = 0
  for (let day = today - 6; day <= today; day++) {
    const entries = {} as Record<DailyEntryId, boolean>
    let n = 0
    for (const e of DAILY_ENTRIES) {
      const has = seen.has(`${day}|${e.variable}`)
      entries[e.id] = has
      if (has) n += 1
    }
    logged += n
    days.push({ day, entries, logged: n })
  }
  return { days, logged, expected: 7 * DAILY_ENTRIES.length }
}

// ---------------------------------------------------------------------------------------------
// Answers -> observations (SPEC section 4). Entered values are never labelled simulated.
// ---------------------------------------------------------------------------------------------

export const SYMPTOMS = [
  { id: 'headache', label: 'Headache' },
  { id: 'nausea', label: 'Nausea or vomiting' },
  { id: 'trouble_sleeping', label: 'Trouble sleeping' },
  { id: 'flank_pain', label: 'Pain in your side or lower back' },
  { id: 'urinary', label: 'Blood in your urine, or pain when passing urine' },
] as const
export type SymptomId = (typeof SYMPTOMS)[number]['id']

/**
 * The renal-stone case asks "any pain in the side or back, blood in the urine, or pain when
 * passing urine?" (engine/rules/cases.json step r4, variable renal_symptoms, yes/no).
 */
export const RENAL_SYMPTOMS: readonly SymptomId[] = ['flank_pain', 'urinary']

export interface NoonAnswers {
  /** null = PVT-B skipped. Demo runs are kept for display and never become observations. */
  pvt: { mode: 'full' | 'demo'; score: PvtScore } | null
  sleepQuality: number | null
  mood: number | null
  fluidIntakeMl: number | null
  urineOutputMl: number | null
  /** null = step skipped; otherwise every item is answered (unticked = no). */
  symptoms: Record<SymptomId, boolean> | null
}

export const EMPTY_ANSWERS: NoonAnswers = {
  pvt: null,
  sleepQuality: null,
  mood: null,
  fluidIntakeMl: null,
  urineOutputMl: null,
  symptoms: null,
}

/** Provenance for values the crewmember entered (self-reports, manual measurements). */
export const PROVENANCE_ENTERED = 'manual'
/** Provenance for values the app measured from the crewmember (PVT-B reaction times). */
export const PROVENANCE_MEASURED = 'measured'

export function buildObservations(a: NoonAnswers, crew: CrewId, t: number): Observation[] {
  const out: Observation[] = []
  const push = (variable: string, value: number, unit: string, source: ObservationSource, provenance: string) =>
    out.push({ crew_id: crew, variable, value, unit, t, source, provenance })

  if (a.pvt && a.pvt.mode === 'full') {
    push('pvt_lapses', a.pvt.score.lapses, 'count', 'app', PROVENANCE_MEASURED)
    if (a.pvt.score.medianRt !== null) push('pvt_median_rt', Math.round(a.pvt.score.medianRt), 'ms', 'app', PROVENANCE_MEASURED)
  }
  if (a.sleepQuality !== null) push('sleep_quality', a.sleepQuality, 'score_1_5', 'app', PROVENANCE_ENTERED)
  if (a.mood !== null) push('mood', a.mood, 'score_1_5', 'app', PROVENANCE_ENTERED)
  if (a.fluidIntakeMl !== null) push('fluid_intake_24h', a.fluidIntakeMl, 'mL', 'manual', PROVENANCE_ENTERED)
  if (a.urineOutputMl !== null) push('urine_volume_24h', a.urineOutputMl, 'mL', 'manual', PROVENANCE_ENTERED)
  if (a.symptoms) {
    for (const s of SYMPTOMS) push(`symptom_${s.id}`, a.symptoms[s.id] ? 1 : 0, 'yes/no', 'manual', PROVENANCE_ENTERED)
    const renal = RENAL_SYMPTOMS.some((id) => a.symptoms?.[id])
    push('renal_symptoms', renal ? 1 : 0, 'yes/no', 'manual', PROVENANCE_ENTERED)
  }
  return out
}

/** Parse a millilitre field: '' -> null (not measured, never zero); otherwise an integer 0-10,000. */
export function parseMl(raw: string): { value: number | null; error: string | null } {
  const s = raw.trim().replace(/[\s,]/g, '')
  if (s === '') return { value: null, error: null }
  if (!/^\d+$/.test(s)) return { value: null, error: 'Enter whole millilitres, digits only (for example 2400).' }
  const v = Number(s)
  if (v > 10_000) return { value: null, error: 'That is more than 10,000 mL in 24 hours. Check the number.' }
  return { value: v, error: null }
}

/** One plain-language logbook line. Mood is never written out: only that it was logged. */
export function logbookText(a: NoonAnswers): string {
  const parts: string[] = []
  if (!a.pvt) parts.push('PVT-B skipped')
  else if (a.pvt.mode === 'demo') parts.push('PVT-B 30-s demo run (not recorded)')
  else {
    const med = a.pvt.score.medianRt === null ? 'no valid response' : `median ${Math.round(a.pvt.score.medianRt)} ms`
    parts.push(`PVT-B ${a.pvt.score.lapses} lapse${a.pvt.score.lapses === 1 ? '' : 's'}, ${med}`)
  }
  parts.push(a.sleepQuality === null ? 'sleep not rated' : `sleep rated ${a.sleepQuality}/5`)
  parts.push(a.mood === null ? 'mood not logged' : 'mood logged (private)')
  parts.push(a.fluidIntakeMl === null ? 'fluid intake not entered' : `fluid intake ${a.fluidIntakeMl} mL`)
  parts.push(a.urineOutputMl === null ? 'urine output not entered' : `urine output ${a.urineOutputMl} mL`)
  if (!a.symptoms) parts.push('symptoms skipped')
  else {
    const on = SYMPTOMS.filter((s) => a.symptoms?.[s.id]).map((s) => s.label.toLowerCase())
    parts.push(on.length ? `reported: ${on.join('; ')}` : 'no symptoms reported')
  }
  return `Noon Sight: ${parts.join(' · ')}`
}
