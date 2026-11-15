# tools/nearest: the closest NASA comes (build time only)

For each claim of absence that LANDFALL makes (for example, no wearable or biosensor requirement in
NASA-STD-3001 Vol 2 Rev F), a small open model ranks 543 of the 545 requirements of NASA-STD-3001 Vol 1
Rev C and Vol 2 Rev F by closeness in meaning to one sentence we wrote. LANDFALL's PDF parsers miss the
other two, [V1 5002] and [V2 10157] (see "What the corpus misses"). The five closest that pass the
clean-text and page gates are frozen, in NASA's words, in `web/src/features/nearest/nearest.json`.

Nothing in this folder ships or runs in the app. The keyword count stays the claim: the model only
adds passages to read. A ranking is not proof of absence.

The app shows the frozen lists as closed expanders: under each searched negative on `#/band`, and after the
delegation quotes and the volume reading on `#/method?s=gap` (`web/src/features/nearest/NearestList.tsx`). They
show the rank only, never a score.

## Frozen before the first ranking run

| File | SHA-256 | Holds |
| --- | --- | --- |
| `queries.json` | `3aa9607718954ceb29966471a32829a6b0bea948b11e5c4342ef781cc42bbae2` | one sentence per claim (6) |
| `labels.json` | `909ebc2d2e88d3fe05581e682aca679c1dbd49b8f4c29805aace6323562801f2` | the hand-named nearest IDs (6) and 31 agent-written questions |

Recorded on 15 Nov 2026 at 12:03 BRT and committed before `rank.py` first ran; the git history shows
the order. The sentences are not reworded after seeing results. If a rewording is ever asked for,
both runs are logged here.

## Model

- `minishlab/potion-base-8M` (MinishLab; licence on the model card: MIT). Static word vectors
  distilled from `BAAI/bge-base-en-v1.5`: a table of vectors that cannot write text.
- Revision `bf8b056651a2c21b8d2565580b8569da283cab23`.
- `model.safetensors`: 30,236,760 B, SHA-256 `f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2`.
- `tokenizer.json`: 683,666 B, SHA-256 `e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50`.
- `config.json`: 202 B, SHA-256 `2a6ac0e9aaa356a68a5688070db78fc3a464fefe85d2f06a1905ce3718687553`.

`rank.py` copies these three files to a fresh directory only after their sizes and SHA-256 match,
and loads them from there with the Hugging Face hub switched off (`HF_HUB_OFFLINE=1`).

Resolved in the isolated environment on 15 Nov 2026, with the licence each package's metadata
states: model2vec 0.10.0 (MIT), numpy 2.5.4 (BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0),
tokenizers 0.23.3 (Apache), safetensors 0.8.0 (Apache), plus their own dependencies (among them
huggingface_hub, joblib and tqdm). None of them is a project dependency: `pyproject.toml` and
`uv.lock` do not list them, and the environment is thrown away after the run.

## Rebuild

From the repository root:

1. The two PDFs must be in the ingest cache. The `std_vol1` and `std_vol2` adapters put them there
   (`uv run python -m ingest std_vol1 std_vol2`, online, once).
2. Corpus, in the project environment (it needs the `ingest` extra):

   ```sh
   uv run python tools/nearest/corpus.py
   ```

   It writes `.cache/nearest/corpus.json` (gitignored): 543 requirements, 76 of the 77 in Vol 1 Rev C
   (`ingest.std_vol1.parse_requirements`) and 467 of the 468 in Vol 2 Rev F (`ingest._std_vol2_pdf.find_requirement`
   over every `[V2 n]` tag on PDF pages 22 to 258). It refuses a cached PDF whose SHA-256 differs from
   the one its snapshot records.
3. Model: `config.json`, `model.safetensors` and `tokenizer.json` of `minishlab/potion-base-8M` at the
   revision above, in one directory (`<model_dir>`).
4. Ranking, in an isolated environment that is never committed:

   ```sh
   uv run --isolated --no-project --with model2vec==0.10.0 --with numpy \
     python -I tools/nearest/rank.py <model_dir> .cache/nearest/corpus.json
   ```

   It writes `web/src/features/nearest/nearest.json` and prints the labelled check. Add
   `--review-out <file>` to also write the first eight passing passages per claim for review.
5. Check: the same command with `--check` re-ranks and exits non-zero unless the result is identical
   to the committed `nearest.json` (same IDs, order, text and flags). `uv run pytest -q ingest/tests/test_nearest.py` checks the
   frozen file without the model.

## What is ranked and what is shown

- Input per requirement: its title, `. `, and its statement (not the rationale), truncated at 512
  tokens, which is model2vec's default. Ranked by cosine similarity to the query; ties keep corpus order.
- The cosine is never written. `nearest.json` keeps only the rank.
- Walking down the ranking, a requirement is shown only if it passes every rule of the gate, until
  five pass. The rules are code (`gate()` in `rank.py`):
  1. it ends in terminal punctuation (`.`, `!` or `?`, optionally followed by a closing quote,
     parenthesis or bracket);
  2. it has no running header `NASA-STD-3001, VOLUME` (upper case: a citation of "Volume 1" is fine);
  3. it has no numbered heading inside it (for example `] 7.1.2.3 Food ...`);
  4. it has no private-use glyph (U+E000 to U+F8FF) and no U+FFFD replacement character;
  5. its statement, with all whitespace removed, occurs in the text of its PDF page, or of that page
     and the next (`page_check`, computed by `corpus.py`).
- 529 of the 543 pass. The 14 that fail: [V1 3017], [V2 5052], [V2 6073], [V2 6115], [V2 6156],
  [V2 6161], [V2 7112], [V2 8025], [V2 9045], [V2 9121], [V2 9122], [V2 10161], [V2 12003] and
  [V2 12041]. All 14 fail rule 1; [V2 6115] also fails rule 4, [V2 6161] rule 2, [V2 7112] and
  [V2 12041] rule 3. None of them ranked above a claim's fifth shown passage in this run, so every
  `skipped` list in `nearest.json` is empty. Among the eight per claim handed to review, the gate
  skipped one: [V2 9121] at position 6 for `storage` (rule 1: its list ends without a full stop).
- `frozen` is true for the 57 requirements the NASA snapshots freeze and verify (20 in
  `std_vol1_requirements`, 37 in `std_vol2_requirements`); their statements are byte-equal to the
  snapshot text. The other passages are cut by the same parsers but not frozen in a snapshot: the
  review stage reads each one against its PDF page (`review.json`).
- `also_named_by_us` is true where the app already names the ID beside the claim:
  `hardware/sensor-map.json` `negatives[].nearest` for the band, and for the alert-number gap the IDs
  that `#/method?s=gap` quotes (the `no_nasa_alert_thresholds` principle in `engine/rules/meta.json`,
  plus the volume readings it shows from the two snapshots' caveats).

## What the corpus misses

The two volumes define 545 requirements; the corpus holds 543. Counted on 15 Nov 2026 in pdfminer's own
text of the two cached PDFs, not through the ingest parsers. `test_each_volume_defines_the_requirements_coverage_counts`
in `ingest/tests/test_nearest.py` recounts the Vol 1 body, both compliance matrices and the two misses, and
the app reads the counts from `web/src/features/nearest/coverage.json`.

| Volume | Defines | How counted | In the corpus | Missed by the parser |
| --- | --- | --- | --- | --- |
| Vol 1 Rev C | 77 | distinct `[V1 n]` tags on PDF pages 1 to 65 whose own text, before the next tag, has "shall": 82 tags, less [V1 3005], [V1 3011], [V1 4021], [V1 6005] and [V1 6007], which appear only in deletion, merger or change-log entries | 76 | [V1 5002], §5.2 Crewmember Training, PDF p. 46 (`ingest.std_vol1.parse_requirements`) |
| Vol 2 Rev F | 468 | distinct `[V2 n]` tags in Table D.2-1, Requirement Compliance Matrix, PDF pages 296 to 338 (the body, pages 22 to 258, carries the same 468) | 467 | [V2 10157], §10.4.4.4 Connector Spacing, PDF p. 216 (`ingest._std_vol2_pdf.find_requirement`) |

Vol 1's own compliance matrix (Appendix D, PDF pages 66 to 86) lists 76 of its 77: it omits [V1 7003],
which §7.3 defines. The footnote under every list in the app says that the model ranked 543 of the 545 and
names the two it did not rank.

What the omission changes, measured once on 15 Nov 2026 by re-ranking with the two statements added by
hand (same model, input form and queries; nothing written or frozen):

- [V1 5002] would rank 4th for `biocompat`, so that list would show it and drop [V2 11024]. It would rank
  9th for `sensor_set` and 85th for `alert_number`, outside their five.
- [V2 10157] would rank 120th or lower for every claim.
- The labelled check would stay 1 of 6 (ranks 1, 152, 15, 7, 166 and 18), and the agent-written questions
  23, 20 and 13 of 31.

## Review

`review.json` (written at the review stage) holds one verdict per shown passage that is not frozen:

```json
{"passages": [{"claim_id": "storage", "id": "V2 6020", "reviewer": "...", "date": "2026-11-15",
               "verdict": "ok", "note": "..."}]}
```

`verdict` is `ok`, `cut` or `garbled`. `rank.py` drops a passage whose verdict is not `ok`
(from that claim, or from every claim when `claim_id` is left out), records it in `skipped` and takes
the next passing one; the new passage then needs its own verdict. `test_nearest.py` requires
`review.json` and an `ok` verdict for every shown passage that is not frozen. The cut rule: if more than
2 of a claim's 5 passages are rejected, show its top 3 or drop that claim.

### The review of 15 Nov 2026

- 48 passages: the first eight that pass the gate for each claim, that is the 20 shown passages that are
  not frozen, the 13 ready replacements at positions 6 to 8 that are not frozen, and all 15 frozen ones
  as a spot-check.
- The reviewer was a Claude Code review agent, run as its own stage after the ranking. It read each
  page of the two cached PDFs (SHA-256 equal to the snapshots) with pdfminer.six directly, not through
  the ingest parsers. For each passage it checked that the statement occurs in one run on its page (or
  that page and the next), that the section number, title and tag come directly before it and
  `[Rationale:` or the next heading directly after, that the tag occurs once on the page, and that it
  has no private-use, U+FFFD, `(cid:)` or empty glyph. `review.json` records the method and one note
  per passage.
- Result: 48 of 48 `ok`. Nothing was dropped, so the cut rule never applied, and re-running `rank.py`
  with `review.json` in place gave a byte-identical `nearest.json` (run log below).
- The verdict judges the text only. Separately, the reviewer flagged the shown passages that weaken or
  contradict their claim (`Reviewer:` in the notes). They stay shown: that is the point of the list.
  - `storage`: [V2 6020] (automatic recording of atmosphere data) contradicts the old wording "No data
    storage or log-duration requirement"; [V2 9120] weakens it slightly. None of them sets a capacity,
    retention or duration.
  - `sensor_set`: [V2 6088] (noise exposure monitored and quantified for each crewmember) weakens the
    claim; it names no device. [V1 3003] (Vol 1, not the claim's Vol 2 scope) weakens the context.
  - `alert_number`: [V2 6153] alerts on celestial dust "approaching defined limits", and Vol 2 sets
    numeric dust limits in [V2 6053] and [V2 6253]; [V2 6023] (trace VOCs) weakens it mildly.
- In the app, a frozen passage is badged "verified"; any other is badged "checked against the PDF page,
  15 Nov 2026" (the review date).

## Notes (`web/src/features/nearest/notes.json`)

LANDFALL's own sentences, written after the review and shown under the card they are about: one factual
sentence under a shown passage the reviewer flagged, quoting NASA's words. Three claims have one:
`sensor_set` ([V2 6088]), `storage` ([V2 6020]) and `alert_number` ([V2 6153]). Every phrase in curly
quotes is listed in the note's `quotes` with its requirement and part (statement or rationale), and the
tests check it against `nearest.json`, the corpus and pdfminer's text of the PDF page. A note never
changes a rank, a count, a pattern or a claim; `rank.py` does not read it.

The `alert_number` note under [V2 6153] was withdrawn on 15 Nov 2026 while the `std_vol2` volume reading said the
alert requirements "delegate limits to the program". It was restored in round 5, once the reading said they "leave the
alert point to the program", even where Vol 2 sets the limit itself. The note says that Vol 2 sets the lunar dust limit
itself ([V2 6053]) but never says how close counts as "approaching".

## The storage claim, narrowed (lead's decision, 15 Nov 2026)

The ranking put [V2 6020] fifth for `storage`: "For each isolatable, habitable compartment, the system
shall automatically record pressure, humidity, temperature, ppO2, and ppCO2 data during crewed
operations." That is a requirement to record data, so "No data storage or log-duration requirement" was
too broad. The claim was narrowed and the search kept:

| Where | Before | After |
| --- | --- | --- |
| `hardware/sensor-map.json` `negatives[storage].claim` (and the generated `sensor-map.md`) | No data storage or log-duration requirement in Vol 2 Rev F. | No storage-capacity, retention or log-duration requirement in Vol 2 Rev F. |
| `ingest/std_vol2.py` `NEGATIVES` label, so `std_vol2_requirements.json` `negatives[5].claim` | No data storage / log duration / retention requirement | No storage capacity / log duration / retention requirement |

- Unchanged: the pattern `data storage|storage capacity|data retention|retention period|log duration|logging duration`,
  its 0 hits over all 398 pages, `nearest`, `queries.json` and the ranking.
- `std_vol2_requirements.json` was rebuilt offline from the cached PDF with the snapshot's own
  `retrieved_at` (2026-11-14T14:47:34Z). Before the label changed, the rebuild was byte-identical to the
  committed file. After it, a JSON diff of the two found one differing path, `$.data.negatives[5].claim`.
  The manifest entry changed only in `bytes` (85,513 to 85,517) and `sha256`. The generated `CITATIONS.md`
  block did not change.
- Before narrowing, Vol 2 Rev F was searched for any requirement that does set a capacity, retention or
  duration for recorded data: every page's text for retain, retention, archive, store, storage, record,
  log, capacity, history, trend, memory, buffer and save, and every sentence that pairs data, records, logs or
  information with a time span. None does. The requirements about recorded data are [V2 6001] (data in
  formats for trend analysis; its rationale's Table 6.1-1 gives example sampling rates, not retention),
  [V2 6020], [V2 9120], [V2 9121], [V2 10120], [V2 10163], [V2 11023] and [V2 11034]. Appendix F asks that
  "Stored data should be searchable to assist in anomaly resolution" and that historical performance
  information on automated processes be available for display; neither sets a capacity, retention or
  duration.
- The note under [V2 6020] says so in the app.

## Results (first run 15 Nov 2026, 12:05 BRT)

| Claim | The five shown, closest first |
| --- | --- |
| `emc` | [V2 6102], [V2 9022], [V1 4032], [V2 9128], [V2 9018] |
| `biocompat` | [V2 11125], [V1 3002], [V1 5003], [V2 7045], [V2 11024] |
| `sensor_set` | [V2 7038], [V2 6088], [V1 3003], [V2 7040], [V1 4005] |
| `battery` | [V2 10123], [V2 9043], [V2 9017], [V2 9039], [V2 9018] |
| `storage` | [V2 9120], [V2 7071], [V2 6014], [V2 7060], [V2 6020] |
| `alert_number` | [V2 6088], [V2 6153], [V2 6023], [V1 3006], [V1 4005] |

30 passages, 10 of them frozen; the other 20 (18 distinct requirements) were reviewed, all `ok`, so the
review left these lists as they are. `rank.py --check` reproduced the same IDs and order.

### Labelled check (`labels.json`, frozen before the run)

1 of 6 in the model's top five.

| Claim | Hand-named | Model rank (1 = closest) |
| --- | --- | --- |
| `emc` | [V2 6102] | 1 |
| `biocompat` | [V2 7076] | 151 |
| `biocompat` | [V2 7081] | 14 |
| `alert_number` | [V2 6164] | 7 |
| `alert_number` | [V2 6022] | 165 |
| `alert_number` | [V2 11036] | 18 |

Not counted (cited by the gap section for fitness-for-duty limits, not as alert requirements):
[V1 4006] rank 38, [V1 4008] rank 92.

### Agent-written questions (`labels.json`)

31 plain-language questions and their expected requirement IDs, written by an agent, not by crew,
so the score reads optimistic. Same model, same input, over the same 543:

- expected requirement in the top five: 23 of 31;
- in the top three: 20 of 31;
- first: 13 of 31.

Neither check is a pass/fail gate.

## Run log

All runs used the frozen `queries.json` and `labels.json` above; `rank.py` refuses to run if either
SHA-256 differs.

| When (BRT, 15 Nov 2026) | Why | Shown IDs and order |
| --- | --- | --- |
| 12:05 | first run | as above |
| between 12:05 and 12:09 (not timed) | `also_named_by_us` for the alert-number gap now includes the volume readings the gap section shows (adds the flag to [V2 6153]) | unchanged; `--check` passed |
| 12:09 | the review input also lists what the gate skipped | unchanged; `--check` passed |
| 12:10 | `rank.py` loads the model once and `--check` compares the whole file | byte-identical output; `--check` passed |
| 12:53 | `review.json` in place (48 verdicts, all `ok`): the review applied | byte-identical output; `--check` passed |
| 14:12 | measurement only, not `rank.py`: the two requirements the corpus misses added by hand ("What the corpus misses") | nothing written; `nearest.json` unchanged |
