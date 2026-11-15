// The Method page's sections, in order. The table of contents, the section numbers and the
// cross-references ("section 3") all come from this list, and each id is a deep link:
// #/method?s=<id> opens that section and scrolls to it.
export const SECTIONS = [
  { s: 'gap', label: 'No alert numbers in NASA-STD-3001' },
  { s: 'limits', label: 'FFD, PEL, POL' },
  { s: 'tiers', label: 'Tier A and Tier B' },
  { s: 'severity', label: 'Severity classes' },
  { s: 'refusals', label: 'Refusals' },
  { s: 'data', label: 'Data honesty' },
  { s: 'architecture', label: 'Architecture' },
  { s: 'coverage', label: "Coverage of NASA's sample IMM output" },
  { s: 'limitations', label: 'Limitations' },
] as const

export type SectionId = (typeof SECTIONS)[number]['s']

export const SECTION_IDS: readonly string[] = SECTIONS.map((x) => x.s)

/** 1-based section number of an id. */
export function secNum(id: SectionId): number {
  return SECTION_IDS.indexOf(id) + 1
}

export function isSectionId(s: string | undefined | null): s is SectionId {
  return !!s && SECTION_IDS.includes(s)
}
