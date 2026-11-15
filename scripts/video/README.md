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
| `still-1-…png` … `still-6-…png` | Lossless frames at the key moments, for review (`still-2a-…` is the hero's first caption) |
| `facts.json` | What the run read from the app, every claim check and its evidence, the timeline, the ffprobe result |
| `work/` | The title-card page and its inlined fonts. Pass `--keep-master` to also keep the lossless master |

Options: `--out=DIR`, `--crf=14` (raised by 2 automatically until the file is under 14 MB),
`--keep-master`. `--only=flip,band` captures only those shots into `work/preview-*.mp4`. That file
is a preview for iterating on one shot, not the deliverable, and the hard limits are not checked. Set
`LF_VIDEO_VERBOSE=1` to log every step.

## Hard limits the script enforces

The script fails, and does not leave a video that looks finished, when any of these is broken:

- The storyboard total is at most 29.5 s, which keeps a margin under the 30.0 s global-judging limit.
  ffprobe then checks the encoded file: duration at most 30.0 s, size under 15 MB, exactly one
  stream (video, no audio), h264 yuv420p 1920x1080 at 30/1.
- **Every claim on screen is checked against the app before its frames are written.** For example,
  "Nearly twenty light-minutes" needs the mission bar's one-way light time to be between 19 and
  20 min. "CM-2's VO2max verdict flips" needs the body map to show OUTSIDE LIMIT for [V1 4002] 36.5
  at Mars and WITHIN LIMIT for [V1 4001] 32.9 at ISS, against the same reading. The final card's two
  claims must match the provenance page's own sentences. The hero's data caption needs the hero to
  name the JPL Horizons ephemeris and to label the flux "Replay of a real event: <replay_of>", with
  `replay_of` read from `/data/swpc_spe_replay.json`. The final card's NEXT line needs gap 724 of
  `/data/hrp_roadmap.json` to read "EIHSO-301: … establish the thresholds …" with status `Open`, and the
  provenance page to say every number is generated from the rules files the engine reads. If the app
  changes and a caption stops being true, the run stops with the claim and what it saw. All the checks
  are in `facts.json`.
- No number is typed into the storyboard. The figures on screen are the app's own pixels, plus facts
  read from the app and its snapshots: the one-way light time (mission bar), the replayed event's name
  (`replay_of`, which carries the year and the satellite) and the gap id (EIHSO-301, from the roadmap
  snapshot). The hero's "Guidance on screen in … s" is measured live by the app in the capture browser,
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
app's own Replay button after the freeze. Each shot starts at the MET where the previous one ended,
so the mission clock runs continuously across the cuts.

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
  become cuts. Scroll anchoring is off too: the one shot that changes content above the viewport
  (the ENV flip) re-anchors its card on every frame.
- **Recapture on a stall.** This is a safety net. If a screenshot or paint has no answer after 4 to
  5 s, the shot's buffered frames are thrown away and the shot is captured again on a fresh page,
  at most 5 attempts. The clock plan is fixed on the first attempt, so a recapture produces the same
  frames. Retries are counted in `facts.json`.

**Overlays.** The script injects two things into the page and adds nothing else. One is the caption
box at bottom-left, with the route in DM Mono and the caption in Inter, both from the page itself.
The other is a green ring around the control that is about to be clicked, which matches the app's
own focus colour (NASA-STD-3001 Table F.5-2, bright green for cursor outlines). Frames are lossless
PNG screenshots piped into a lossless master, and the master is encoded to H.264 once.

## Storyboard (29.5 s)

The timing follows the timed script of the Project Submission Guide (13 Nov 2026): "[0:00] Introduce
yourself", "[0:05] Name your project", "[0:10] Describe your idea: … share how using NASA's free and
open data and Space Agency Partner data made your proposed solution possible" and "[0:20-0:30] Look into
the future". The data caption is on screen from 9.9 s and the NEXT line from 24.1 s.

| s | Shot | On screen |
|---|---|---|
| 0.0 to 2.0 | card | LANDFALL / Guilherme Amaro · NASA Space Apps Challenge 2026 [TEAM-CARD-TBC: this card's text is left as it was until the user confirms the team] |
| 2.0 to 5.0 | card | Nearly twenty light-minutes from Earth, behind the Sun, the crew has to act on its own. (The kicker prints the mission bar's one-way light time.) |
| 5.0 to 7.0 | card | LANDFALL / Earth-independent health navigation for exploration crews |
| 7.0 to 12.5 | `#/` | The dual counter replays: ASK HOUSTON rolls up the round trip, then turns NO LINK · SOLAR CONJUNCTION. The LANDFALL card lights with the latency measured on this visit and the primary action. Caption 1: "Houston's reply is days away. LANDFALL's guidance is already on screen." From 2.9 s into the shot, caption 2: "Real data: JPL Horizons light time and the" + `replay_of` ("October 1989 solar proton event (GOES-7)"). |
| 12.5 to 16.0 | `#/case/spe_shelter` | Scroll to Detect, then open "Why this fired": value, limit, margin, and the [V2 6164] wording. |
| 16.0 to 19.0 | `#/body?region=heart`, CM-2 | ENV goes from Mars to ISS. The link goes from LOS to AOS, and the VO2max card changes from OUTSIDE [V1 4002] 36.5 to WITHIN [V1 4001] 32.9 against the same 35.1 reading. The ring moves from ENV to the card. |
| 19.0 to 20.5 | `#/band` | The NOT MEASURABLE HERE hand-off boundary |
| 20.5 to 22.5 | `#/provenance` | The chip counts, then "Design choices — no published basis" |
| 22.5 to 29.5 | card | Every NASA limit links to the standard it came from. Every number with no published basis is labelled as ours. Then the NEXT line: "Next: NASA's open gap EIHSO-301 asks to “establish the thresholds”. Here every threshold is data a program can replace." (it quotes the gap; it never says LANDFALL closes it). Then the URL and the app's own footer, word for word ("Not endorsed by NASA. Not a medical device…"). |

## Project-page figures: `make-figures.mjs`

```bash
node scripts/video/make-figures.mjs                        # captures the public deployment
node scripts/video/make-figures.mjs http://localhost:4814  # or any build; --only=F2,F3 to iterate
```

It writes to `.cache/video/figures/` (gitignored). The project page accepts JPG, PNG and GIF images up
to 10 MB; every file stays under that and the GIF under 4 MB, or the run fails.

| File | What it is |
|---|---|
| `F1-dual-counter.gif` / `.png` | The hero shot of the video (`make-video.mjs --only=hero`, the same checks and frozen clock), as a GIF (fps 12, 960 px wide, palettegen/paletteuse) and the shot's last still |
| `og.png` | The 1200x630 link-preview crop of F1's still. Copy it to `web/public/og.png` after the final capture |
| `F2-why-this-fired.png` | The opened "Why this fired" panel of the shelter case, element-clipped, at 2 device pixels per CSS pixel |
| `F3-vo2max-mars-iss.png` | CM-2's VO2max card at the Mars base and at ISS, each opened from its own `?env=` deep link, joined with ffmpeg `hstack`. The label strip above each card repeats the mission bar's environment, link and light time |
| `F4-provenance-summary.png` | The provenance page's intro and per-chip counts |
| `figures.md` | Alt text, caption and the deep link that reproduces each figure, plus the checks each one passed |
| `facts-figures.json` | What the run read from the app, every check, every output file |

Each figure runs the `ctx.assert` checks of its video shot in `storyboard.mjs` (and `factsPass`) before
it is written. Captions and alt text are built from the facts of the run; the run fails if `figures.md`
prints a number that `facts-figures.json` does not hold, or a caption prints a number the app did not
show.
