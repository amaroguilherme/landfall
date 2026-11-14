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
// Symptoms. The six renal ones are, in order and in the same words, the red flags of the renal-stone
// case's red-flag question (engine/rules/cases.json renal_stone, step r4 red_flags; a test checks
// them), which follow the HRR risk statement (D5). Chest pain, shortness of breath and a change in
// vision have no LANDFALL case: they prompt "tell your Crew Medical Officer now".
// ---------------------------------------------------------------------------------------------

export const SYMPTOMS = [
  { id: 'headache', label: 'Headache' },
  { id: 'trouble_sleeping', label: 'Trouble sleeping' },
  { id: 'flank_pain', label: 'Pain in the side or back (flank)' },
  { id: 'blood_in_urine', label: 'Blood in the urine' },
  { id: 'painful_urination', label: 'Pain or burning when passing urine' },
  { id: 'fever_chills', label: 'Fever or chills' },
  { id: 'nausea_vomiting', label: 'Nausea or vomiting' },
  { id: 'cannot_pass_urine', label: 'Being unable to pass urine' },
  { id: 'chest_pain', label: 'Chest pain' },
  { id: 'short_of_breath', label: 'Shortness of breath' },
  { id: 'vision_change', label: 'A change in your vision' },
  { id: 'rash', label: 'Rash or skin irritation' },
] as const
export type SymptomId = (typeof SYMPTOMS)[number]['id']

/** The renal-stone case's red flags (cases.json renal_stone r4 red_flags, same order and words). */
export const RENAL_SYMPTOMS: readonly SymptomId[] = ['flank_pain', 'blood_in_urine', 'painful_urination', 'fever_chills', 'nausea_vomiting', 'cannot_pass_urine']

/** Symptoms no LANDFALL case covers that still mean "tell your Crew Medical Officer now". */
export const URGENT_SYMPTOMS: readonly SymptomId[] = ['chest_pain', 'short_of_breath', 'vision_change']

export function symptomLabel(id: SymptomId): string {
  return SYMPTOMS.find((s) => s.id === id)?.label ?? id
}

// ---------------------------------------------------------------------------------------------
// Medical kit: cuff blood pressure and fingerstick glucose (D8), twice a week
// ---------------------------------------------------------------------------------------------

export type KitVariable = 'bp_systolic' | 'bp_diastolic' | 'glucose'

export interface KitSpec {
  variable: KitVariable
  unit: 'mmHg' | 'mg/dL'
  label: string
  /**
   * Entry range (design choice): wide enough for any real reading of a cuff or a glucometer, so a
   * number outside it is a typing or unit error. It is an entry check, never a clinical limit.
   */
  min: number
  max: number
}

export const KIT_SPECS: Record<KitVariable, KitSpec> = {
  bp_systolic: { variable: 'bp_systolic', unit: 'mmHg', label: 'Systolic (top number)', min: 40, max: 300 },
  bp_diastolic: { variable: 'bp_diastolic', unit: 'mmHg', label: 'Diastolic (bottom number)', min: 20, max: 200 },
  glucose: { variable: 'glucose', unit: 'mg/dL', label: 'Blood glucose', min: 10, max: 800 },
}

export const KIT_ENTRY_RANGE_RATIONALE =
  'An entry check, not a clinical limit: the range is wide enough for any real reading, so a number outside it is a typing or unit error. LANDFALL alerts only on a reliable change against your own baseline.'

/** Twice a week: a reading is due again from this many MET days after the last one (design choice). */
export const KIT_INTERVAL_DAYS = 3

/** Parse one kit field: '' -> null (not taken, never zero); whole numbers only, inside the entry range. */
export function parseKit(raw: string, spec: KitSpec): { value: number | null; error: string | null } {
  const s = raw.trim().replace(/\s/g, '')
  if (s === '') return { value: null, error: null }
  if (spec.unit === 'mg/dL' && /^\d+[.,]\d+$/.test(s)) {
    return {
      value: null,
      error: 'LANDFALL takes whole mg/dL. A reading with a decimal point is probably in mmol/L: check the unit on the meter. Do not convert it here.',
    }
  }
  if (!/^\d+$/.test(s)) return { value: null, error: `Enter whole ${spec.unit}, digits only.` }
  const v = Number(s)
  if (v < spec.min || v > spec.max) {
    return { value: null, error: `${v} ${spec.unit} is outside the entry range (${spec.min}–${spec.max} ${spec.unit}): check the number.` }
  }
  return { value: v, error: null }
}

/** Cross-check of one cuff reading: the top number must be the larger one. */
export function bpPairError(systolic: number | null, diastolic: number | null): string | null {
  if (systolic === null && diastolic === null) return null
  if (systolic === null || diastolic === null) return 'Enter both numbers of the cuff reading, or leave both empty.'
  if (systolic <= diastolic) return 'The top number (systolic) must be larger than the bottom one (diastolic). Check the order.'
  return null
}

/** A personal band (Tier B, from the engine): mean +/- the minimum detectable change. */
export interface Band {
  lo: number
  hi: number
}

/** True when a value lies outside the crewmember's own band: ask to re-measure and confirm. */
export function outsideBand(value: number | null, band: Band | null): boolean {
  if (value === null || !band) return false
  return value < band.lo || value > band.hi
}

export interface KitSchedule {
  /** MET day of the last reading (simulated record or this session), or null. */
  lastDay: number | null
  daysSince: number | null
  due: boolean
  /** First MET day the next reading is due (lastDay + KIT_INTERVAL_DAYS). */
  nextDay: number | null
}

/** Twice a week: due when the last reading is KIT_INTERVAL_DAYS or more MET days old (or there is none). */
export function kitSchedule(readingTimes: readonly number[], today: number, now: number): KitSchedule {
  let last: number | null = null
  for (const t of readingTimes) if (t <= now && (last === null || t > last)) last = t
  if (last === null) return { lastDay: null, daysSince: null, due: true, nextDay: null }
  const lastDay = metDayOf(last)
  const daysSince = today - lastDay
  return { lastDay, daysSince, due: daysSince >= KIT_INTERVAL_DAYS, nextDay: lastDay + KIT_INTERVAL_DAYS }
}

export const KIT_SKIP_REASONS = [
  { id: 'not_due', label: 'Not due today: it is twice a week' },
  { id: 'kit_unavailable', label: 'The cuff or the glucometer is not available' },
  { id: 'later', label: 'No time now: later today' },
  { id: 'other', label: 'Another reason' },
] as const
export type KitSkipId = (typeof KIT_SKIP_REASONS)[number]['id']

/** The plain-language reason recorded in the logbook ('' when the "other" text is empty). */
export function kitSkipText(id: KitSkipId | null, other: string): string {
  if (!id) return ''
  if (id === 'other') return other.trim() ? `other: ${other.trim()}` : ''
  return KIT_SKIP_REASONS.find((r) => r.id === id)?.label ?? ''
}

/** The medical-kit step's raw entries (kept while the crewmember moves between steps). */
export interface KitDraft {
  sysRaw: string
  diaRaw: string
  gluRaw: string
  /** "I re-measured and this is what the device shows", required for a value outside the own band. */
  confirmBp: boolean
  confirmGlu: boolean
  skipId: KitSkipId | null
  skipOther: string
}

export const EMPTY_KIT: KitDraft = { sysRaw: '', diaRaw: '', gluRaw: '', confirmBp: false, confirmGlu: false, skipId: null, skipOther: '' }

export interface KitCheck {
  systolic: number | null
  diastolic: number | null
  glucose: number | null
  errors: { systolic: string | null; diastolic: string | null; pair: string | null; glucose: string | null }
  /** The reading lies outside the crewmember's own band (engine Tier B): re-measure, then confirm. */
  bpOutside: boolean
  glucoseOutside: boolean
  needsConfirm: boolean
  bpTaken: boolean
  glucoseTaken: boolean
  /** Something was not taken today, so a reason is asked for. */
  missing: boolean
  skipText: string
  ok: boolean
}

export function checkKit(d: KitDraft, bands: Partial<Record<KitVariable, Band | null>>): KitCheck {
  const sys = parseKit(d.sysRaw, KIT_SPECS.bp_systolic)
  const dia = parseKit(d.diaRaw, KIT_SPECS.bp_diastolic)
  const glu = parseKit(d.gluRaw, KIT_SPECS.glucose)
  const pair = sys.error || dia.error ? null : bpPairError(sys.value, dia.value)
  const bpTaken = sys.value !== null && dia.value !== null && !pair
  const glucoseTaken = glu.value !== null
  const bpOutside = bpTaken && (outsideBand(sys.value, bands.bp_systolic ?? null) || outsideBand(dia.value, bands.bp_diastolic ?? null))
  const glucoseOutside = glucoseTaken && outsideBand(glu.value, bands.glucose ?? null)
  const needsConfirm = (bpOutside && !d.confirmBp) || (glucoseOutside && !d.confirmGlu)
  const missing = !bpTaken || !glucoseTaken
  const skipText = missing ? kitSkipText(d.skipId, d.skipOther) : ''
  const hasError = Boolean(sys.error || dia.error || pair || glu.error)
  return {
    systolic: bpTaken ? sys.value : null,
    diastolic: bpTaken ? dia.value : null,
    glucose: glu.value,
    errors: { systolic: sys.error, diastolic: dia.error, pair, glucose: glu.error },
    bpOutside,
    glucoseOutside,
    needsConfirm,
    bpTaken,
    glucoseTaken,
    missing,
    skipText,
    ok: !hasError && !needsConfirm && (!missing || skipText !== ''),
  }
}

// ---------------------------------------------------------------------------------------------
// Answers -> observations (SPEC section 4). Entered values are never labelled simulated.
// ---------------------------------------------------------------------------------------------

export interface NoonAnswers {
  /** null = PVT-B skipped. Demo runs are kept for display and never become observations. */
  pvt: { mode: 'full' | 'demo'; score: PvtScore } | null
  sleepQuality: number | null
  mood: number | null
  fluidIntakeMl: number | null
  urineOutputMl: number | null
  /** Medical kit (twice a week): one cuff reading and one fingerstick; null = not taken. */
  bpSystolic: number | null
  bpDiastolic: number | null
  glucoseMgDl: number | null
  /** Why a kit reading was not taken today (plain language), or null. */
  kitSkip: string | null
  /** null = step skipped; otherwise every item is answered (unticked = no). */
  symptoms: Record<SymptomId, boolean> | null
}

export const EMPTY_ANSWERS: NoonAnswers = {
  pvt: null,
  sleepQuality: null,
  mood: null,
  fluidIntakeMl: null,
  urineOutputMl: null,
  bpSystolic: null,
  bpDiastolic: null,
  glucoseMgDl: null,
  kitSkip: null,
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
  // One cuff reading is a pair: both numbers or neither.
  if (a.bpSystolic !== null && a.bpDiastolic !== null) {
    push('bp_systolic', a.bpSystolic, KIT_SPECS.bp_systolic.unit, 'manual', PROVENANCE_ENTERED)
    push('bp_diastolic', a.bpDiastolic, KIT_SPECS.bp_diastolic.unit, 'manual', PROVENANCE_ENTERED)
  }
  if (a.glucoseMgDl !== null) push('glucose', a.glucoseMgDl, KIT_SPECS.glucose.unit, 'manual', PROVENANCE_ENTERED)
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
  const kit: string[] = []
  if (a.bpSystolic !== null && a.bpDiastolic !== null) kit.push(`blood pressure ${a.bpSystolic}/${a.bpDiastolic} mmHg`)
  if (a.glucoseMgDl !== null) kit.push(`glucose ${a.glucoseMgDl} mg/dL`)
  if (kit.length) parts.push(kit.join(', '))
  if (a.kitSkip) parts.push(`${kit.length ? 'rest of the medical kit' : 'medical kit'} not taken (${a.kitSkip[0].toLowerCase()}${a.kitSkip.slice(1)})`)
  else if (!kit.length) parts.push('medical kit not taken')
  if (!a.symptoms) parts.push('symptoms skipped')
  else {
    const on = SYMPTOMS.filter((s) => a.symptoms?.[s.id]).map((s) => s.label.toLowerCase())
    parts.push(on.length ? `reported: ${on.join('; ')}` : 'no symptoms reported')
  }
  return `Noon Sight: ${parts.join(' · ')}`
}
