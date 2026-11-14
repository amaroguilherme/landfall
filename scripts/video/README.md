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
| `still-1-…png` … `still-6-…png` | Lossless frames at the six key moments, for review |
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
  claims must match the provenance page's own sentences. If the app changes and a caption stops
  being true, the run stops with the claim and what it saw. All the checks are in `facts.json`.
- No number is typed into the storyboard. The figures on screen are the app's own pixels, plus the
  one-way light time that the problem card reads from the mission bar. The hero's "Guidance on
  screen in … s" is measured live by the app in the capture browser, so it differs slightly from run
  to run (0.02 to 0.05 s so far). The app labels it "Measured in this browser".

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

| s | Shot | On screen |
|---|---|---|
| 0.0 to 2.0 | card | LANDFALL / Guilherme Amaro · NASA Space Apps Challenge 2026 |
| 2.0 to 5.0 | card | Nearly twenty light-minutes from Earth, behind the Sun, the crew has to act on its own. (The kicker prints the mission bar's one-way light time.) |
| 5.0 to 7.5 | card | LANDFALL / Earth-independent health navigation for exploration crews |
| 7.5 to 12.5 | `#/` | The dual counter replays: ASK HOUSTON rolls up the round trip, then turns QUEUED · SOLAR CONJUNCTION. The LANDFALL card lights with the measured latency and the primary action. |
| 12.5 to 16.0 | `#/case/spe_shelter` | Scroll to Detect, then open "Why this fired": value, limit, margin, and the [V2 6164] wording. |
| 16.0 to 19.0 | `#/body?region=heart`, CM-2 | ENV goes from Mars to ISS. The link goes from LOS to AOS, and the VO2max card changes from OUTSIDE [V1 4002] 36.5 to WITHIN [V1 4001] 32.9 against the same 35.1 reading. The ring moves from ENV to the card. |
| 19.0 to 20.5 | `#/band` | The NOT MEASURABLE HERE hand-off boundary |
| 20.5 to 22.5 | `#/provenance` | The chip counts, then "Design choices — no published basis" |
| 22.5 to 29.5 | card | Every NASA limit links to the standard it came from. Every number with no published basis is labelled as ours. Then the URL and the app's own footer, word for word ("Not endorsed by NASA. Not a medical device…"). |
