// Section: severity. NASA's alert classes (NASA-STD-3001 Vol 2 Table 10.3-1, verbatim from the frozen
// snapshot) and LANDFALL's mapping of findings onto them (engine/rules/meta.json severity_mapping, read
// at build). Nothing here is firing, so the classes are drawn neutral: shape + word, no alert colour.
import { useSnapshot } from '../../app/data'
import type { Severity } from '../../app/vocab'
import { Chip, Citation, FreshnessChip, ReqId, SeverityIcon } from '../../ui'
import { FoldPanel } from './fold'
import { alertClassFor, alertClasses, alertTable, describeWhen, normReqId } from './rules'
import type { MetaFile, Vol2Data } from './rules'
import { MissingNote, RichText, Verbatim } from './shared'

const ORDER = ['emergency', 'warning', 'caution', 'advisory', 'nominal']

function ClassWord({ severity }: { severity: string }) {
  return (
    <span className="lf-m-class">
      <SeverityIcon severity={severity as Severity} size={13} />
      {severity}
    </span>
  )
}

export function SeveritySection({ meta }: { meta: MetaFile }) {
  const v2 = useSnapshot<Vol2Data>('std_vol2_requirements')
  const classes = alertClasses(v2.data)
  const sm = meta.severity_mapping
  const rows = [...sm.rows].sort((a, b) => ORDER.indexOf(a.severity ?? a.severity_max ?? 'nominal') - ORDER.indexOf(b.severity ?? b.severity_max ?? 'nominal'))
  const prioritize = v2.data?.requirements.find((r) => normReqId(r.id) === 'V2 10175')
  // [V2 10114] asks for visual and audio annunciation; LANDFALL's alerts are visual only (declared below, quoted from the frozen text).
  const annunciate = v2.data?.requirements.find((r) => normReqId(r.id) === 'V2 10114')
  const noEmergency = meta.refusals.find((r) => r.id === 'no_emergency_alarm')
  // The Caution definition as meta.json severity_mapping quotes it (Table 10.3-1), for the escalation gap below.
  const cautionDefinition =
    sm.rows.map((r) => (r.severity === 'caution' ? (r as { class_definition?: string }).class_definition : undefined)).find((d): d is string => !!d) ?? null
  const table = alertTable(v2.data)
  return (
    <FoldPanel
      s="severity"
      eyebrow="Alert classes"
      title="Severity: NASA’s alert classes, LANDFALL’s mapping"
      abstract="Which finding is a Warning, a Caution or an Advisory, against NASA-STD-3001 Vol 2 Table 10.3-1."
      footer={
        <>
          <span>Classes: NASA-STD-3001 Vol 2 Table 10.3-1 · mapping: engine/rules/meta.json (severity_mapping)</span>
          <FreshnessChip meta={v2.snapshot} status={v2.status} id="std_vol2_requirements" />
        </>
      }
    >
      <p>
        NASA defines the alert classes and their priority in Table 10.3-1, and <ReqId id="V2 10175" /> requires a system to prioritize
        alerts by it. The class definitions, word for word:
      </p>
      {classes.length ? (
        <table className="lf-m-table lf-m-blocks">
          <caption className="lf-m-caption">
            {table?.caption ?? 'Table 10.3-1'} (definitions verbatim; auditory column omitted: LANDFALL’s alerts are visual only, see “Known display
            gaps” below)
          </caption>
          <thead>
            <tr>
              <th scope="col">Alert type</th>
              <th scope="col">Definition</th>
              <th scope="col" className="num">
                Priority
              </th>
              <th scope="col">Visual</th>
            </tr>
          </thead>
          <tbody>
            {classes.map((c) => (
              <tr key={c.type}>
                <th scope="row">{c.type}</th>
                <td data-label="Definition">“{c.definition}”</td>
                <td className="num" data-label="Priority">
                  <span className="lf-mono">{c.priority}</span>
                </td>
                <td data-label="Visual">{c.visual}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : v2.status === 'loading' ? (
        <p className="lf-m-small">Reading Table 10.3-1 from the frozen snapshot…</p>
      ) : (
        <MissingNote>
          Table 10.3-1 is not in snapshot <code>std_vol2_requirements.json</code>, so its definitions cannot be shown.
        </MissingNote>
      )}
      {prioritize?.rationale ? (
        <Verbatim
          lead={<ReqId id="V2 10175" />}
          text={prioritize.rationale.split(/(?<=\.)\s+/).slice(0, 2).join(' ')}
          cite={<>Rationale (first two sentences), NASA-STD-3001 Vol 2 Rev {v2.data?.document.revision}</>}
        />
      ) : null}
      <h3 className="lf-m-h4">LANDFALL’s mapping, as the engine reads it</h3>
      <p className="lf-m-small">
        Read from <code>engine/rules/meta.json</code> as the page renders: when a finding matches a row, it gets that class. Basis of the
        mapping: <Chip kind={sm.chip} />{' '}
        {sm.source.kind === 'design_choice' && sm.source.rationale ? <RichText text={sm.source.rationale} /> : <Citation source={sm.source as never} />}
      </p>
      <table className="lf-m-table lf-m-blocks">
        <caption className="sr-only">Severity mapping rows from meta.json</caption>
        <thead>
          <tr>
            <th scope="col">When a finding is</th>
            <th scope="col">Class</th>
            <th scope="col">NASA definition of that class</th>
            <th scope="col">Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const sev = r.severity ?? r.severity_max ?? null
            const cls = sev ? alertClassFor(classes, sev) : null
            return (
              <tr key={r.id}>
                <th scope="row">
                  {describeWhen(r.when)}{' '}
                  <a className="lf-m-rowlink" href={`#/provenance?id=${encodeURIComponent(`severity.${r.id}`)}`}>
                    provenance
                  </a>
                </th>
                <td data-label="Class">{sev ? r.severity ? <ClassWord severity={sev} /> : <>at most <ClassWord severity={sev} /></> : '—'}</td>
                <td data-label="NASA definition" className="lf-m-why">
                  {cls ? <>“{cls.definition}”</> : sev === 'nominal' ? <span className="lf-m-small">not an alert class: nothing is annunciated</span> : '—'}
                </td>
                <td data-label="Note" className="lf-m-why">
                  {r.note ? <RichText text={r.note} /> : null}
                  {(r as { colour_note?: string }).colour_note ? (
                    <>
                      {' '}
                      <RichText text={(r as { colour_note?: string }).colour_note!} />
                    </>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {noEmergency ? (
        <p>
          <strong>
            <RichText text={noEmergency.text} />
          </strong>
        </p>
      ) : null}
      <div className="lf-m-aside">
        <h3 className="lf-m-h4">Known display gaps</h3>
        <p>
          <ReqId id="V2 10114" /> asks for visual and audio annunciation of Emergency, Warning and Caution; LANDFALL’s alerts are visual only, and
          the vehicle’s caution and warning system provides the sound. LANDFALL plays none, so on its own a LANDFALL Warning or Caution is seen, not
          heard. <Chip kind="design choice" />
        </p>
        {annunciate ? (
          <Verbatim
            lead={<ReqId id="V2 10114" />}
            text={annunciate.text}
            cite={
              <>
                NASA-STD-3001 Vol 2 Rev {v2.data?.document.revision}, section {annunciate.section}
                {annunciate.title ? <>, “{annunciate.title}”</> : null}
                {annunciate.pdf_page ? (
                  <>
                    , PDF page <span className="lf-mono">{annunciate.pdf_page}</span>
                  </>
                ) : null}
              </>
            }
          />
        ) : v2.status === 'loading' ? (
          <p className="lf-m-small">
            Reading <ReqId id="V2 10114" /> from the frozen snapshot…
          </p>
        ) : (
          <MissingNote>
            <ReqId id="V2 10114" /> is not in snapshot <code>std_vol2_requirements.json</code>, so its text cannot be quoted here.
          </MissingNote>
        )}
        {cautionDefinition ? (
          <p data-gap="escalation-class">
            An escalation keeps the class of its case: a renal red-flag “yes” or an overdue reassessment tells the crew to act now, but its
            alert line stays a Caution, which Table 10.3-1 defines as “{cautionDefinition}” The words carry the urgency; raising the class needs
            an engine change and is not in this build. <Chip kind="design choice" />
          </p>
        ) : null}
      </div>
    </FoldPanel>
  )
}
