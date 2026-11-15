// #/eva model (pure, no React): the [V1 6006] evidence board.
//
// NASA-STD-3001 Vol 1 [V1 6006]: "All crewmembers shall be medically cleared to perform an EVA by ground
// medical support personnel prior to each EVA." Its rationale names what the flight surgeon on the ground
// looks at: "recent medical evaluations, fitness sessions, and other metrics of health and performance".
// This module gathers what LANDFALL holds under each of those three phrases for one crewmember, and dates
// every item against the earliest moment the ground could review it (light time only, from the engine's
// commsEta through computeComms). It never decides anything: every verdict is the engine's finding, read
// as it is, and the page names the decision as the program's and the ground's. LANDFALL never clears anyone.
import { CASE_DEFS } from '../../app/caseTimeline'
import type { CaseView } from '../../app/caseTimeline'
import type { CommsStatus } from '../../app/comms'
import type { Finding } from '../../app/engine'
import type { MissionEvaluation, PersonalEvaluation, RuleEvaluation } from '../../app/evaluate'
import type { Environment } from '../../app/scenario'
import { CHIP_DEFS } from '../../app/vocab'
import type { CrewId, Observation } from '../../app/vocab'

// ---- snapshot shapes (only the fields read here) ---------------------------------------------------------

export interface StdRequirementRec {
  /** "V1 6006" (Vol 1) or "[V2 11037]" (Vol 2, stored with brackets). */
  id: string
  section?: string
  section_title?: string
  title?: string
  printed_page?: number
  text?: string
  rationale?: string | null
  verified?: boolean
}
export interface StdData {
  requirements?: StdRequirementRec[]
}
export interface SScaleData {
  levels?: Array<{ level: string; n: number; descriptor?: string; threshold_pfu?: number; effects?: Record<string, string> }>
}
export interface SepEventsData {
  literature?: {
    title?: string
    authors?: string[]
    journal?: { journal?: string; published?: string }
    doi_url?: string
    arxiv_abs?: string
    quotes?: Array<{ id: string; text: string }>
  }
}

export interface EvaSources {
  vol1: StdData | null
  vol2: StdData | null
  sScale: SScaleData | null
  sep: SepEventsData | null
}

// ---- constants (each one is either a verbatim phrase checked against the snapshot, or labelled) ---------

export const REQ_ID = 'V1 6006'
/** The three phrases of [V1 6006]'s rationale, in its order. Checked verbatim against the frozen text. */
export const EVIDENCE_PHRASES = [
  { id: 'medical', phrase: 'recent medical evaluations' },
  { id: 'fitness', phrase: 'fitness sessions' },
  { id: 'metrics', phrase: 'other metrics of health and performance' },
] as const
export type GroupId = (typeof EVIDENCE_PHRASES)[number]['id']

/** The fixed sentence the page always shows. */
export const NEVER_CLEARS = 'LANDFALL never clears anyone for EVA.'
/** What "earliest review" means everywhere on the page. */
export const EARLIEST_REVIEW_LABEL = 'light time only, before any review time'

/** Tier B indicators listed under "other metrics of health and performance", in this order (personal.json ids). */
export const METRIC_INDICATORS = [
  'pvt_lapses',
  'pvt_median_rt',
  'sleep_duration',
  'sleep_midpoint_shift',
  'resting_hr',
  'hrv_sdnn',
  'bp_systolic',
  'bp_diastolic',
] as const

/** Case statuses that count as open here (the body map's footprint set: an escalated case is still live). */
export const OPEN_CASE_STATUSES: ReadonlySet<string> = new Set(['detected', 'acting', 'watch', 'escalated'])
export const CASE_STATUS_WORDS: Record<string, string> = {
  idle: 'Not open',
  detected: 'Open · detected',
  acting: 'Open · acting',
  watch: 'Open · watch (tripwire armed)',
  escalated: 'Escalated',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
}

/**
 * Design choice: a link that is up but one minute or more each way is "delayed" (Mars outside a conjunction).
 * Below it (ISS, cislunar, the Moon: a few seconds at most) the ground is "reachable". Only shown when it applies.
 */
export const DELAYED_ONE_WAY_S = 60

export const SHELTER_CASE_ID = 'spe_shelter'
export const SHELTER_STEP_ID = 'p1'
export const RAD_QUOTE_ID = 'shelter_30_min'
/** Where the RAD team's figure applies (its nowcast runs on Curiosity's RAD record at Gale crater, Mars). */
export const RAD_ENV = 'mars_surface'

/** A provenance chip id by its source kind (meta.json chips): renamed chips stay correct. */
export function chipFor(kind: string, fallback: string): string {
  return CHIP_DEFS.find((c) => c.source_kind === kind)?.id ?? fallback
}

// ---- requirement text ----------------------------------------------------------------------------------

const bare = (id: string) => id.replace(/^\[|\]$/g, '').trim()

/** One requirement of a frozen standard snapshot by id ("V1 6006" or "[V2 11037]"), or null. */
export function findRequirement(data: StdData | null | undefined, id: string): StdRequirementRec | null {
  const want = bare(id)
  return data?.requirements?.find((r) => bare(r.id) === want) ?? null
}

/** The rationale's own words, without the "[Rationale: ...]" wrapper the Vol 1 snapshot keeps. */
export function rationaleText(rec: StdRequirementRec | null | undefined): string | null {
  const r = rec?.rationale
  if (typeof r !== 'string' || !r.trim()) return null
  return r
    .trim()
    .replace(/^\[\s*Rationale:\s*/i, '')
    .replace(/\]$/, '')
    .trim()
}

export interface QuotedRequirement {
  id: string
  text: string
  rationale: string | null
  section: string | null
  title: string | null
  page: number | null
  verified: boolean
}

export function quoted(data: StdData | null | undefined, id: string): QuotedRequirement | null {
  const r = findRequirement(data, id)
  if (!r || typeof r.text !== 'string') return null
  return {
    id: bare(r.id),
    text: r.text,
    rationale: rationaleText(r),
    section: r.section ?? null,
    title: r.section_title ?? r.title ?? null,
    page: typeof r.printed_page === 'number' ? r.printed_page : null,
    verified: r.verified === true,
  }
}

// ---- ground ----------------------------------------------------------------------------------------------

export type Ground = 'reachable' | 'delayed' | 'unreachable'

export function groundOf(c: Pick<CommsStatus, 'blocked' | 'link' | 'one_way_s'>): Ground {
  if (c.blocked || c.link === 'LOS') return 'unreachable'
  if (c.one_way_s !== null && c.one_way_s >= DELAYED_ONE_WAY_S) return 'delayed'
  return 'reachable'
}

// ---- evidence rows ---------------------------------------------------------------------------------------

export type Side = 'before' | 'after'

export interface EvidenceRow {
  key: string
  label: string
  /** A number in `unit`, or null (then `text` or missing). */
  value: number | null
  unit: string | null
  /** A word value (a case status), when the row has no number. */
  text: string | null
  /** MET the evidence became available (a test's or reading's t, a case's opening). */
  met: number | null
  /** t - met. */
  ageNow: number | null
  /** earliestReviewT - met: how old it is when the ground could first review it. */
  ageAtReview: number | null
  /** Before or after loss of signal; null when the link is up (no loss of signal) or the time is unknown. */
  side: Side | null
  /** Provenance chip of the comparison (the rule's or the indicator's), or null. */
  chip: string | null
  /** No value to show: cyan, [V2 10020]. Never shown as within. (A stale value is shown, with the engine's cyan badge.) */
  missing: boolean
  /** The engine's finding, read as it is (never recomputed here). */
  finding: Finding | null
  /** The floor a fitness test is compared with: value, unit and requirement id (from the rule). */
  floor: { value: number; unit: string; requirementId: string | null } | null
  /** In-app link to the record behind the row. */
  href: string | null
}

export interface EvidenceGroup {
  id: GroupId
  /** The rationale's phrase, verbatim. */
  phrase: string
  /** The phrase was found verbatim in the frozen rationale (false when the snapshot is missing). */
  phraseFound: boolean
  rows: EvidenceRow[]
}

interface Clock {
  t: number
  losT: number | null
  earliestReviewT: number | null
}

function dated(clock: Clock, met: number | null): Pick<EvidenceRow, 'met' | 'ageNow' | 'ageAtReview' | 'side'> {
  if (met === null || !Number.isFinite(met)) return { met: null, ageNow: null, ageAtReview: null, side: null }
  return {
    met,
    ageNow: clock.t - met,
    ageAtReview: clock.earliestReviewT === null ? null : clock.earliestReviewT - met,
    side: clock.losT === null ? null : met < clock.losT ? 'before' : 'after',
  }
}

function row(clock: Clock, r: Omit<EvidenceRow, 'met' | 'ageNow' | 'ageAtReview' | 'side'> & { met: number | null }): EvidenceRow {
  return { ...r, ...dated(clock, r.met) }
}

/** The crewmember's open cases (opened at or before t), oldest first. */
export function openCases(caseViews: readonly CaseView[], crewId: CrewId, t: number): CaseView[] {
  return caseViews
    .filter((v) => v.crewId === crewId && OPEN_CASE_STATUSES.has(v.state.status) && typeof v.state.opened_at === 'number' && v.state.opened_at <= t)
    .sort((a, b) => (a.state.opened_at ?? 0) - (b.state.opened_at ?? 0))
}

/** Latest Noon Sight check-in at or before t: the simulated record's check-in times plus this session's fixes. */
export function latestCheckin(checkins: readonly number[], t: number): number | null {
  let best: number | null = null
  for (const c of checkins) if (Number.isFinite(c) && c <= t && (best === null || c > best)) best = c
  return best
}

/** The FFD VO2max rule evaluation that applies in this environment, or null. */
export function vo2Rule(evaluation: MissionEvaluation | null, crewId: CrewId, envId: string): RuleEvaluation | null {
  const crew = evaluation?.crew[crewId]
  if (!crew) return null
  return crew.tierA.find((r) => r.rule.variable === 'vo2max' && r.rule.category === 'FFD' && r.rule.applies_to.includes(envId)) ?? null
}

function requirementIdOf(r: RuleEvaluation): string | null {
  const src = r.rule.source as { requirement_id?: unknown }
  return typeof src.requirement_id === 'string' ? src.requirement_id : null
}

function medicalRows(clock: Clock, crewId: CrewId, caseViews: readonly CaseView[], checkins: readonly number[]): EvidenceRow[] {
  const out: EvidenceRow[] = openCases(caseViews, crewId, clock.t).map((v) =>
    row(clock, {
      key: `case:${v.caseId}`,
      label: `Open case: ${v.def.title ?? v.caseId}`,
      value: null,
      unit: null,
      text: CASE_STATUS_WORDS[v.state.status] ?? v.state.status,
      met: v.state.opened_at ?? null,
      chip: null,
      missing: false,
      finding: null,
      floor: null,
      href: `#/case/${v.caseId}?crew=${crewId}`,
    }),
  )
  const last = latestCheckin(checkins, clock.t)
  out.push(
    row(clock, {
      key: 'noon-sight',
      label: 'Latest Noon Sight (the daily self-check)',
      value: null,
      unit: null,
      text: last === null ? null : 'Logged',
      met: last,
      chip: null,
      missing: last === null,
      finding: null,
      floor: null,
      href: '#/noon-sight',
    }),
  )
  return out
}

function fitnessRows(clock: Clock, crewId: CrewId, envId: string, evaluation: MissionEvaluation | null, observations: readonly Observation[]): EvidenceRow[] {
  const ffd = vo2Rule(evaluation, crewId, envId)
  const out: EvidenceRow[] = []
  const latestT = ffd?.input.t ?? null
  // Missing = no value at all. A stale or insufficient-data verdict keeps its value; the engine's badge says so (cyan).
  const missing = !ffd || ffd.input.value === null
  out.push(
    row(clock, {
      key: 'vo2max:latest',
      label: 'VO₂max, latest test',
      value: ffd?.input.value ?? null,
      unit: ffd?.rule.unit ?? 'ml/min/kg',
      text: null,
      met: latestT,
      chip: ffd?.rule.chip ?? null,
      missing,
      finding: ffd?.finding ?? null,
      floor: ffd ? { value: ffd.rule.limit, unit: ffd.rule.unit, requirementId: requirementIdOf(ffd) } : null,
      href: `#/trends?crew=${crewId}`,
    }),
  )
  // Earlier tests of the record, newest first: values only (the verdict is the latest test's, from the engine).
  const unit = ffd?.rule.unit ?? 'ml/min/kg'
  const earlier = observations
    .filter((o) => o.variable === 'vo2max' && o.crew_id === crewId && o.unit === unit && o.t <= clock.t && o.t !== latestT && Number.isFinite(o.value))
    .sort((a, b) => b.t - a.t)
  for (const o of earlier) {
    out.push(
      row(clock, {
        key: `vo2max:${o.t}`,
        label: 'VO₂max, earlier test',
        value: o.value,
        unit: o.unit,
        text: null,
        met: o.t,
        chip: null,
        missing: false,
        finding: null,
        floor: null,
        href: `#/trends?crew=${crewId}`,
      }),
    )
  }
  return out
}

function metricRows(clock: Clock, crewId: CrewId, evaluation: MissionEvaluation | null): EvidenceRow[] {
  const tierB: readonly PersonalEvaluation[] = evaluation?.crew[crewId]?.tierB ?? []
  return METRIC_INDICATORS.map((id) => {
    const ev = tierB.find((e) => e.indicator.id === id) ?? null
    const current = ev?.current ?? null
    const missing = !ev || current === null
    return row(clock, {
      key: `tierb:${id}`,
      label: ev?.indicator.label ?? id,
      value: current?.value ?? null,
      unit: ev?.indicator.unit ?? null,
      text: null,
      met: current?.t ?? null,
      chip: ev?.finding.chip ?? null,
      missing,
      finding: ev?.finding ?? null,
      floor: null,
      href: `#/trends?crew=${crewId}`,
    })
  })
}

// ---- constraints, monitoring, options ------------------------------------------------------------------

export interface SLevelConstraint {
  level: number | null
  flux: number | null
  fluxT: number | null
  /** Provenance of that reading ('replay': the time-shifted October 1989 record; a crew entry otherwise). */
  provenance: string | null
  /** The OPS finding at the current level (the engine's), or null below S1. */
  finding: Finding | null
  /** The OPS rule's chip: 'design choice' at Mars (NOAA's scale applied away from Earth), NOAA-published elsewhere. */
  ruleChip: string | null
  atMars: boolean
  /** At S3 or above: NOAA's Biological effect for the current level, verbatim, and the level's name. */
  quote: { level: string; descriptor: string | null; text: string } | null
}

export interface ShelterConstraint {
  /** The case's own title (cases.json). */
  title: string
  open: boolean
  status: string | null
  openedAt: number | null
  /** Procedure step p1 of the shelter case, verbatim from cases.json. */
  p1: string | null
  href: string
}

export interface RadConstraint {
  text: string
  /** "Löwe et al., Space Weather 2025" from the snapshot's own record. */
  cite: string | null
  url: string | null
}

export interface EvaConstraints {
  sLevel: SLevelConstraint
  shelter: ShelterConstraint | null
  rad: RadConstraint | null
}

export interface EvaMonitoring {
  requirements: QuotedRequirement[]
  /** One-way light time now (s); null when unknown. */
  oneWayS: number | null
  blocked: boolean
}

export type OptionId = 'postpone' | 'before_los' | 'delegate'

export interface ProgramOption {
  id: OptionId
  /** Seconds from now until a ground answer could arrive (postpone). */
  waitS: number | null
  /** MET of the earliest review (postpone, before_los). */
  earliestReviewT: number | null
  /** MET of loss of signal (before_los). */
  losT: number | null
  /** How old a review made at loss of signal is when the next one could arrive (before_los): earliestReviewT - losT. */
  staleAtNextReviewS: number | null
}

export interface EvaBoard {
  crewId: CrewId
  envId: string
  t: number
  ground: Ground
  /** MET of loss of signal (start of the conjunction window containing t), when the ground is unreachable. */
  losT: number | null
  /** MET the link resumes, when the ground is unreachable. */
  resumeT: number | null
  /** t + comms.earliest_reply_s: light time only, before any review time. */
  earliestReviewT: number | null
  earliestReviewLabel: string
  /** Round trip now (s), from computeComms. */
  roundTripS: number | null
  /** Round trip when the link resumes (s), from computeComms at resumes_at; null when the link is up. */
  roundTripAtResumeS: number | null
  oneWayS: number | null
  requirement: QuotedRequirement | null
  groups: EvidenceGroup[]
  constraints: EvaConstraints
  monitoring: EvaMonitoring
  options: ProgramOption[]
}

export interface EvaBoardInput {
  crewId: CrewId
  env: Pick<Environment, 'id'>
  /** computeComms (useComms) for this environment at t. */
  comms: CommsStatus
  /** computeComms at comms.resumes_at (the round trip when the link is back), or null. */
  commsAtResume?: CommsStatus | null
  evaluation: MissionEvaluation | null
  /** useCases().cases (every crewmember x case); filtered here. */
  caseViews: readonly CaseView[]
  /** This crewmember's observations of the fitness variable(s) (observationsFor ... 'vo2max'), any order. */
  observations: readonly Observation[]
  /** Noon Sight check-in times of this crewmember (simulated record + this session). */
  checkins?: readonly number[]
  /** Frozen snapshots for the quotations (null = not in this build). */
  sources: EvaSources
  /** Evaluation MET (the clock minute): the same t the comms and the findings were computed at. */
  t: number
}

function sLevelConstraint(evaluation: MissionEvaluation | null, sScale: SScaleData | null): SLevelConstraint {
  const ops = evaluation?.ops ?? null
  const level = ops?.s_level ?? null
  const rec = level !== null && level >= 3 ? (sScale?.levels?.find((l) => l.n === level) ?? null) : null
  const text = rec?.effects?.Biological
  return {
    level,
    flux: ops?.flux ?? null,
    fluxT: ops?.t ?? null,
    provenance: ops?.provenance ?? null,
    finding: ops?.active?.finding ?? null,
    ruleChip: ops?.active?.rule.chip ?? null,
    atMars: ops?.kind === 'onboard_monitor',
    quote: rec && typeof text === 'string' ? { level: rec.level, descriptor: rec.descriptor ?? null, text } : null,
  }
}

function shelterConstraint(caseViews: readonly CaseView[], crewId: CrewId, t: number): ShelterConstraint | null {
  const def = CASE_DEFS.find((d) => d.id === SHELTER_CASE_ID)
  const text = def?.procedure?.find((s) => s.id === SHELTER_STEP_ID)?.text
  const p1 = typeof text === 'string' ? text : null
  const view = caseViews.find((v) => v.crewId === crewId && v.caseId === SHELTER_CASE_ID) ?? null
  const open = !!view && OPEN_CASE_STATUSES.has(view.state.status) && typeof view.state.opened_at === 'number' && view.state.opened_at <= t
  if (!open) return null
  return {
    title: def?.title ?? SHELTER_CASE_ID,
    open,
    status: view!.state.status,
    openedAt: view!.state.opened_at ?? null,
    p1,
    href: `#/case/${SHELTER_CASE_ID}?crew=${crewId}`,
  }
}

function radConstraint(sep: SepEventsData | null, envId: string): RadConstraint | null {
  if (envId !== RAD_ENV) return null
  const lit = sep?.literature
  const text = lit?.quotes?.find((q) => q.id === RAD_QUOTE_ID)?.text
  if (typeof text !== 'string') return null
  const first = lit?.authors?.[0]
  const family = first ? (first.split(' ').slice(-1)[0] ?? first) : null
  const year = lit?.journal?.published?.slice(0, 4) ?? null
  const journal = lit?.journal?.journal ?? null
  const cite = family ? `${family} et al.${journal ? `, ${journal}` : ''}${year ? ` ${year}` : ''}` : null
  return { text, cite, url: lit?.doi_url ?? lit?.arxiv_abs ?? null }
}

/** The board. Pure: the same inputs always give the same board. */
export function evaBoard(input: EvaBoardInput): EvaBoard {
  const { crewId, env, comms, evaluation, caseViews, observations, sources, t } = input
  const ground = groundOf(comms)
  const unreachable = ground === 'unreachable'
  const losT = unreachable ? (comms.window?.start ?? null) : null
  const resumeT = unreachable ? comms.resumes_at : null
  const earliestReviewT = comms.earliest_reply_s === null ? null : t + comms.earliest_reply_s
  const clock: Clock = { t, losT, earliestReviewT }
  const requirement = quoted(sources.vol1, REQ_ID)
  const rationale = requirement?.rationale ?? ''

  const groups: EvidenceGroup[] = EVIDENCE_PHRASES.map(({ id, phrase }) => ({
    id,
    phrase,
    phraseFound: rationale.includes(phrase),
    rows:
      id === 'medical'
        ? medicalRows(clock, crewId, caseViews, input.checkins ?? [])
        : id === 'fitness'
          ? fitnessRows(clock, crewId, env.id, evaluation, observations)
          : metricRows(clock, crewId, evaluation),
  }))

  const monitoring: EvaMonitoring = {
    requirements: ['[V2 11037]', '[V2 11038]'].map((id) => quoted(sources.vol2, id)).filter((q): q is QuotedRequirement => q !== null),
    oneWayS: comms.one_way_s,
    blocked: comms.blocked,
  }

  const options: ProgramOption[] = [
    { id: 'postpone', waitS: comms.earliest_reply_s, earliestReviewT, losT: null, staleAtNextReviewS: null },
    {
      id: 'before_los',
      waitS: null,
      earliestReviewT,
      losT,
      staleAtNextReviewS: losT !== null && earliestReviewT !== null ? earliestReviewT - losT : null,
    },
    { id: 'delegate', waitS: null, earliestReviewT: null, losT: null, staleAtNextReviewS: null },
  ]

  return {
    crewId,
    envId: env.id,
    t,
    ground,
    losT,
    resumeT,
    earliestReviewT,
    earliestReviewLabel: EARLIEST_REVIEW_LABEL,
    roundTripS: comms.round_trip_s,
    roundTripAtResumeS: unreachable ? (input.commsAtResume?.round_trip_s ?? null) : null,
    oneWayS: comms.one_way_s,
    requirement,
    groups,
    constraints: {
      sLevel: sLevelConstraint(evaluation, sources.sScale),
      shelter: shelterConstraint(caseViews, crewId, t),
      rad: radConstraint(sources.sep, env.id),
    },
    monitoring,
    options,
  }
}
