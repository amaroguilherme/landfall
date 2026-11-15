# LANDFALL 30-second demo video

One command rebuilds the judge video from the live app:

```bash
node scripts/video/make-video.mjs                      # captures https://landfall.landfall-web.workers.dev
node scripts/video/make-video.mjs http://localhost:4301  # or any other build of the app
```

You need Node 22 or newer (it uses the global `WebSocket` and `fetch`), Google Chrome at the default
macOS path (or `--chrome=PATH` / `CHROME=...`), and `ffmpeg` and `ffprobe` on `PATH`. There are no npm
dependencies. A run takes about 2 to 3 minutes.

| Output (`.cache/video/`, gitignored) | What it is |
|---|---|
| `landfall-30s.mp4` | 1920x1080, 30 fps, H.264 High, yuv420p, BT.709, faststart, **no audio track**, 29.5 s |
| `still-0-…png` … `still-6-…png` | Lossless frames at the key moments, for review: the title card, the problem card, `still-1a-sol242`, the hero (`still-2a-…` with its first caption, `still-2-…` with the data caption), the case, the flip, `still-4a-eva`, the band and the final card. Also `still-2b-hero-no-caption` (the hero's last frame without the caption, not a video frame; `og.png` is cut from it) |
| `facts.json` | What the run read from the app, every claim check and its evidence, the timeline, the viewport, the placeholders still on screen, the ffprobe result |
| `work/` | The title-card page and its inlined fonts. Pass `--keep-master` to also keep the lossless master. After a failed run, `work/stage/` holds that run's partial output |

**Placeholders.** Text that is not final goes on screen as a visible marker, never as a guess. `PLACEHOLDERS` in
`storyboard.mjs` lists each one; the run logs it at the start, ends with `NOT FOR UPLOAD YET`, and writes it to
`facts.json` (`placeholders`). The list is empty: the title card's credit (`TEAM_LINE`, "Team Isaac Clarke: Guilherme
Amaro, Ayra Castilho") was confirmed on 15 Nov 2026.

**Viewport.** The app shots are laid out at 1440x810 CSS px and rendered at 4/3 device pixels per CSS pixel
(`VIEW` in `storyboard.mjs`), which fills the 1920x1080 frame exactly; every frame's size is checked. At 1440 px the
app's own layout spans most of the frame, so its text is a third larger on screen than in a 1920 px layout and
stays readable in a small player. The title cards are laid out at 1920x1080 and rendered at 1.

Options: `--out=DIR`, `--crf=14` (raised by 2 automatically until the file is under 14 MB),
`--keep-master`. `--only=flip,band` captures only those shots into `work/preview-*.mp4`. That file
is a preview for iterating on one shot, not the deliverable, and the hard limits are not checked. Set
`LF_VIDEO_VERBOSE=1` to log every step.

## Hard limits the script enforces

The script fails, and does not leave a video that looks finished, when any of these is broken. A full run
writes its stills, `facts.json` and the mp4 to `work/stage/` and moves them into `.cache/video/` only once every
check below has passed. A run that fails, whether on a claim, on a full disk or on an encode over the limits,
replaces nothing: `.cache/video/` keeps the last good set, all from one run, and the error says so.

- The storyboard total is at most 29.5 s, which keeps a margin under the 30.0 s global-judging limit.
  ffprobe then checks the encoded file: duration at most 30.0 s, size under 15 MB, exactly one
  stream (video, no audio), h264 yuv420p 1920x1080 at 30/1.
- **Every claim on screen is checked against the app before its frames are written.** For example,
  "Nearly twenty light-minutes" needs the mission bar's one-way light time to be between 19 and
  20 min. "CM-2's VO2max verdict flips" needs the body map to show OUTSIDE LIMIT for [V1 4002] 36.5
  at Mars and WITHIN LIMIT for [V1 4001] 32.9 at ISS, against the same reading. The case caption ("the
  reading, the threshold, whose number it is, and the NASA requirement") needs the "Why this fired" grid
  to show a Value row, a Threshold row naming NOAA S3 with a design-choice chip, an "Above the threshold
  by" row that equals value minus threshold, the badge "At or above S3" and no Limit or Margin row, and
  the basis to quote [V2 6164]. The final card's two claims must match the provenance page's own
  sentences. The hero's data caption needs the hero to name the JPL Horizons ephemeris and to label the
  flux "Replay of a real event: <replay_of>", with `replay_of` read from `/data/swpc_spe_replay.json`.
  The final card's NEXT line quotes gap 724 of `/data/hrp_roadmap.json`: its title must start "EIHSO-301:"
  and hold "We need to determine the on-board, intelligent systems that will support crew health and
  performance" word for word (the line keeps the gap's own verb and quotes what is to be determined; the
  gap's "establish the thresholds" is about how such systems are implemented, not alert thresholds), its
  status must be `Open`, and the provenance page must say every number is generated from the rules files
  the engine reads. The title card's event must be the app's own (its footer). The Sol 242 caption needs
  the panel's title ("It has happened: a solar storm at Gale crater in solar conjunction (<month year>)",
  which gives the caption its month and year), Hassler et al.'s Fig. 5 caption ("while Mars was in solar
  conjunction", on the same sol), the panel's "On sol <n>, Curiosity’s RAD measured a solar particle event
  at Gale crater." and its RAD peak line; the frame's JPL quote ("plan to suspend commanding from …") and
  window line are checked too. The EVA caption needs [V1 6006] verbatim on the board ("…medically cleared
  to perform an EVA by ground medical support personnel prior to each EVA"), the board's own "LANDFALL
  never clears anyone for EVA." at its head and under the program options, and no clearance verdict
  ("cleared for", "go for EVA", "no-go", "cleared to EVA") anywhere outside NASA's quoted text; the frame's
  earliest review must be labelled "light time only, before any review time" and equal the hero's "Earliest
  reply", and the board's round trip when the link resumes must be the one the hero's earliest-reply line
  adds at link-up (read from both pages; no check pins that line's wording). If the app changes and a
  caption stops being true, the run stops with the claim and what it saw. All the checks are in `facts.json`.
- **The hero frames show the current UI.** The round-2 video was captured from an older build, so the hero
  shot asserts what its frames show: the onboard badge is `S3 · Warning` in the Warning class, MET and the
  link countdown print with no leading zeros (412/14:20:…, 11/05:59:…), the conjunction window is "modelled
  from JPL Horizons geometry", the S3 reading is the Mars-orbit space-weather monitor's, the habitat's
  radiation monitoring system raises the alarm, and the ground packet reads "Prepared (held on board)".
- **Nothing the caption names is under the caption.** Each app shot lists in `clear` what must be on screen
  on its last frame, below the mission bar and above the caption (the Sol 242 title, JPL quote, window line
  and sol sentence, the counters, the "Why this fired" grid and its [V2 6164] basis, the VO2max card, the
  [V1 6006] requirement, its citation, the ground-link line and the earliest review, the NOT MEASURABLE
  HERE boundary, the chip counts). A miss fails
  the run; when the caption's soft top edge only dims an element, the run records a warning.
- No number is typed into the storyboard. The figures on screen are the app's own pixels, plus facts
  read from the app and its snapshots: the one-way light time (mission bar), the replayed event's name
  (`replay_of`, which carries the year and the satellite), the gap id (EIHSO-301, from the roadmap
  snapshot) and the Sol 242 caption's month and year (from the panel's own title). The hero's "Guidance on screen in … s" is measured live by the app in the capture browser,
  so it differs slightly from run to run (0.02 to 0.05 s so far). The app labels it "Measured in this
  browser".
- **The hero's latency survives the frozen clock.** The shot restarts the dual counter with the app's
  own Replay button, and Replay also re-measures the onboard answer. Under the frozen capture clock
  that re-measure could only read whole capture steps (it showed exactly 0.033 s, one frame at 30 fps,
  in every run). So the shot reads the latency the app measured on the real clock when the page
  loaded, clicks Replay, lets React render the click, and steps the clock by exactly that latency
  before the browser paints. Two checks then require the replayed number and the last frame's number
  to equal the real-clock measurement (`hero.frames` and `hero.end` in `facts.json`). One fixed 200 ms
  step after it keeps the sequence's timers on the same frames whatever the latency was.

## How it works

- `storyboard.mjs` holds the words and timings, the checks for each shot, and the page actions
  (scroll, click, select). Edit this file to change the video.
- `make-video.mjs` runs the storyboard. It reads the facts, captures every frame, encodes the
  video and verifies it.
- `card.html` is the plain typographic title card: carbon-90 `#17171b`, with the app's own Inter,
  Public Sans Web and DM Mono, downloaded from the deployed app and inlined. There is no imagery
  and no logo.
- `cdp.mjs` is a minimal client for the Chrome DevTools protocol.

**Reproducibility.** Each shot opens a fresh page, so the in-memory app state starts at the
scenario default (Mars, CM-1) every time. The page loads in real time, which keeps the hero's
"Guidance on screen in … s" a genuine in-browser measurement. Then the app's clock is frozen. A
small shim injected at document start (`CLOCK_SHIM` in `cdp.mjs`) passes `performance.now`,
`Date.now`, `setTimeout` and `setInterval` through to the real clock until the freeze. After the
freeze it moves them only when the pipeline steps them, exactly 1/30 s per captured frame, and
every timer that falls due runs at its own virtual time. Chrome itself keeps rendering on its real
clock. Animations, the MET clock and the scripted scrolls therefore fall on the same frames on
every run, however slow the machine is. The hero's dual-counter sequence is restarted with the
app's own Replay button after the freeze. Each app shot starts at the MET where the previous one
ended, except the hero: its `onPaused` steps the clock 1.5 s (`HERO_PREROLL_MS`) after the Replay
click and before frame 0, and that step is not taken off its start, so the mission clock moves on
1.5 s at the cut from Sol 242 into the hero. In this render the mission bar reads 412/14:20:09 on
Sol 242's last frame and 412/14:20:11 on the hero's first (`timeline` in `facts.json`). Every other
cut is continuous.

The first version used Chrome's own virtual time (`Emulation.setVirtualTimePolicy`) instead. Under
it, Chrome stopped answering screenshots on large pages: always on the first scroll of
`#/provenance`, and intermittently on the body map. The in-page clock has not stalled.

Three more details:

- **Settle before freezing.** About 1.5 s after load, the app shell warms every route chunk and
  snapshot on idle. Each page waits until it is at least 6.5 s old and the network has been quiet
  for 1 s, so nothing loads or re-renders in the background while frames are captured.
- **Capture stylesheet.** CSS transitions run on Chrome's real clock, not on the frozen app clock,
  so they would land on different frames on each run. The injected stylesheet turns them off. The
  app's only CSS motion is 120 ms transitions on the chevrons and the body-figure fills, so they
  become cuts. Scroll anchoring is off too: the shot that changes content above the viewport (the ENV
  flip) re-anchors its card on every frame, and so do the Sol 242 and EVA shots, whose panels sit below
  content the shell may still re-render.
- **Recapture on a stall.** This is a safety net. If a screenshot or paint has no answer after 4 to
  5 s, the shot's buffered frames are thrown away and the shot is captured again on a fresh page,
  at most 5 attempts. The clock plan is fixed on the first attempt, so a recapture produces the same
  frames. Retries are counted in `facts.json`.

**Overlays.** The script injects two things into the page and adds nothing else. One is the caption,
a full-width lower third with a soft top edge, the route in DM Mono and the caption in Inter, both from
the page itself. It hides the bottom of the page whole, so it never leaves half a line of app text
beside it. It is up from the first frame of every app shot to the last. When the hero's caption changes,
only its words cross-fade (frame spec `words`): a band that dipped to transparent between the two captions
would flash the page bottom it hides. Its sizes are written in output pixels and scaled by 1/DSF, so it is the same size whatever
the page's CSS viewport. The other is a green ring around the control that is about to be clicked, or around where to look next (the
VO2max verdict after the flip, the EVA board's earliest review), which matches the app's own focus colour (NASA-STD-3001 Table F.5-2, bright green for cursor outlines). Frames
are lossless PNG screenshots piped into a lossless master, and the master is encoded to H.264 once.

**Framing.** Scroll targets are computed from the page, so no line of text is cut by the mission bar's
edge: the body shot puts the "Limits that apply" section (its eyebrow included) 12 px under the bar and
anchors the VO2max card there across the ENV change; the provenance shot ends with the chip counts 16 px
under the bar; the case shot scrolls until the "Why this fired" grid and basis end above the caption, and
never past the Detect heading; the Sol 242 shot holds its panel's top 12 px under the bar; the EVA shot holds
the requirement panel 12 px under the bar, or higher (its eyebrow still below the bar) until the earliest
review, ring included, ends above the caption's soft edge.

## Storyboard (29.5 s)

The timing follows the timed script of the Project Submission Guide (13 Nov 2026): "[0:00] Introduce
yourself", "[0:05] Name your project", "[0:10] Describe your idea: … share how using NASA's free and
open data and Space Agency Partner data made your proposed solution possible" and "[0:20-0:30] Look into
the future". The title card names the project and the team from 0:00 (the separate name card was cut to make
room for Sol 242 and the EVA board), the data caption is on screen from 9.9 s and the NEXT line from 25.1 s.

| s | Shot | On screen |
|---|---|---|
| 0.0 to 2.0 | card | LANDFALL / Team Isaac Clarke: Guilherme Amaro, Ayra Castilho / NASA Space Apps Challenge 2026 (the event name is the app footer's). |
| 2.0 to 5.0 | card | Nearly twenty light-minutes from Earth, behind the Sun, the crew has to act on its own. (The kicker prints the mission bar's one-way light time.) |
| 5.0 to 7.0 | `#/radiation?env=mars_surface` | The Sol 242 panel's head, its top 12 px under the mission bar: "It has happened: a solar storm at Gale crater in solar conjunction (April 2013)", JPL's "Curiosity's controllers plan to suspend commanding from April 4 to May 1." and the window line under it, "On sol 242, Curiosity’s RAD measured a solar particle event at Gale crater.", and the STEREO-B HET chart. Caption: "It has happened: April 2013, Mars behind the Sun. / Curiosity measured a solar storm at Gale crater." (month and year from the panel's title). The RAD peak line starts about 860 CSS px below the title's top (`sol242.geo` in `facts.json`), more than the 576 px between the bar and the caption, so it is read and checked but not framed. |
| 7.0 to 12.5 | `#/` | The dual counter replays: ASK HOUSTON rolls up the round trip, then turns NO LINK · SOLAR CONJUNCTION and "Link resumes in …" (days), over "Earliest reply … (the … round trip added at link-up)". The LANDFALL card is lit with S3 · WARNING, the latency measured on this visit and the primary action. Caption 1: "Houston's reply is days away. LANDFALL's guidance is already on screen." From 2.9 s into the shot, caption 2: "Real data: JPL Horizons light time and the" + `replay_of` ("October 1989 solar proton event (GOES-7)"). |
| 12.5 to 16.0 | `#/case/spe_shelter` | Scroll to Detect, then open "Why this fired": the value, the threshold (NOAA S3, reached at or above; a design choice at Mars), how far above it, "At or above S3", and the [V2 6164] basis. Caption: "Why this fired: the reading, the threshold, whose number it is, and the NASA requirement." |
| 16.0 to 19.0 | `#/body?region=heart`, CM-2 | ENV goes from Mars to ISS. The link goes from LOS to AOS, and the VO2max card changes from OUTSIDE [V1 4002] 36.5 to WITHIN [V1 4001] 32.9 against the same 35.1 reading. The ring moves from ENV to the card. The kicker names no organ: the card says VO2max is a whole-body fitness tag (and links to the EVA board). |
| 19.0 to 21.0 | `#/eva?crew=CM-2` | The EVA evidence board's head at the Mars base (a fresh page, so Mars again, not the ISS the flip ended on): "What NASA requires" with [V1 6006] verbatim and its citation, then the ground link: "No ground link: solar conjunction.", loss of signal, link resumes, the earliest review (ringed from 0.85 s) and the round trip now and when the link resumes. Caption: "NASA: the ground clears the crew before each EVA. / LANDFALL clears no one." The board's own "LANDFALL never clears anyone for EVA." sits above the requirement panel, out of the frame, so the caption carries it. |
| 21.0 to 22.5 | `#/band` | The NOT MEASURABLE HERE hand-off boundary. The kicker "hardware concept, never built" is checked against the page's eyebrow and device boundary. |
| 22.5 to 24.5 | `#/provenance` | Scroll to the chip counts, "Design choices — no published basis" and its "listed here as ours" statement |
| 24.5 to 29.5 | card | Every NASA limit links to the standard it came from. Every number with no published basis is labelled as ours. Then the NEXT line: "Next: NASA's open gap EIHSO-301 asks to determine / “the on-board, intelligent systems that will support crew health and performance”. / LANDFALL proposes one; its thresholds are data a program can replace." (it quotes the gap's own words for what is to be determined; it never says LANDFALL closes the gap). Then the URL and the app's own footer, word for word ("Not endorsed by NASA. Not a medical device…"). Every block is in by 1.6 s, top to bottom, and stays to the end: the claims 4.5 and 4.2 s, the NEXT line 4.0 s, the URL 3.6 s, the small print 3.4 s. |

## Project-page figures: `make-figures.mjs`

```bash
node scripts/video/make-figures.mjs                        # captures the public deployment
node scripts/video/make-figures.mjs http://localhost:4814  # or any build; --only=F2,F3 to iterate
```

It writes to `.cache/video/figures/` (gitignored). The project page accepts JPG, PNG and GIF images up
to 10 MB; every file stays under that and the GIF under 4 MB, or the run fails. As in the video, the figures,
`figures.md` and `facts-figures.json` are staged in `work/stage/` and moved into place together only when every
check has passed, so a failed run never leaves a new image beside an old caption.

| File | What it is |
|---|---|
| `F1-dual-counter.gif` / `.png` | The hero shot of the video (`make-video.mjs --only=hero`, the same checks and frozen clock), as a GIF (fps 12, 960 px wide, palettegen/paletteuse) and the shot's last still |
| `og.png` | The 1200x630 link-preview crop (the top 1920x1008 of the frame, scaled by 0.625) of the hero's last frame captured without the video caption (`still-2b-hero-no-caption`). Copy it to `web/public/og.png` after the final capture |
| `F2-why-this-fired.png` | The opened "Why this fired" panel of the shelter case (value, NOAA's S3 threshold, how far above it, the [V2 6164] basis), element-clipped, at 2 device pixels per CSS pixel |
| `F3-vo2max-mars-iss.png` | CM-2's VO2max card at the Mars base and at ISS, each opened from its own `?env=` deep link, joined with ffmpeg `hstack`. The label strip above each card repeats the mission bar's environment, link and light time |
| `F4-provenance-summary.png` | The provenance page's intro and per-chip counts |
| `F5-verify-run.png` | `#/verify` after pressing Run: the four check cards (N of N vectors agree with the Python reference, N of N snapshots match manifest.json, the rules digest recomputed in the browser, 0 requests to other origins), element-clipped at 2 device pixels per CSS pixel. Run is pressed once the service worker serves the page, so the engine card carries no offline note |
| `figures.md` | Alt text, caption and the deep link that reproduces each figure, plus the checks each one passed |
| `facts-figures.json` | What the run read from the app, every check, every output file |

Each figure runs the `ctx.assert` checks of its video shot in `storyboard.mjs` (and `factsPass`) before
it is written. F5 has no video shot: it checks that all four cards pass, reads each count from its card, and
requires the recomputed rules digest to equal both the one the verify page attributes to the cue cards and the
one `#/card/spe_shelter` prints. Captions and alt text are built from the facts of the run; the run fails if `figures.md`
prints a number that `facts-figures.json` does not hold, or a caption prints a number the app did not
show. Element figures are measured only after the page has settled (the app's warmup window and network
idle, as in the video).

**The F3 crop.** A capture from the live URL on 15 Nov 00:04 BRT passed every claim check yet cropped F3
wrongly, and nothing in the run checked the crop itself. The old crop also had three weak points, any of
which can move the clip: it took the first applicable limit card on the page (not necessarily the VO2max
card), it placed the label strip before the viewport change, and it measured without waiting for the page
to settle. The crop is now held by checks too. The VO2max card is tagged by its label and is the only card the clip may take; the label
strip is placed again after the viewport change, against the layout that is captured; and the run fails
unless, for each half, the strip ends where the card starts (within 1 px), no other limit card meets the
clip, the whole card and strip are inside it, the clip is on screen below the mission bar, and the PNG is
the clip at 2 px per CSS px. The crop geometry of each half is in `facts-figures.json` (`F3.<env>.crop`).
