# LANDFALL usability test: protocol

**Tester:** Ayra Castilho (team Isaac Clarke)  ·  **Observer:** Guilherme Amaro  ·  **Time needed:** about 20 minutes
**Where:** the live app, https://landfall.landfall-web.workers.dev, on whatever device you normally use.

This check uses NASA's own crew-interface measures from NASA-STD-3001 Vol 2 Rev F, section 5.1:

- the **NASA Modified System Usability Scale** (NMSUS, Figure 5.1-1), with the pass mark of [V2 10001];
- the **Bedford Workload Scale**, with the pass marks of [V2 5007];
- the **design-induced error rates** of Table 5.1-1 ([V2 10002]).

With one tester from our own team this is a developmental check, not a verification. NASA recommends the NMSUS
"with participants that have been trained on the tasks and system design to a pre-set performance criterion"
([V2 10001] rationale), and our tester is not trained on LANDFALL.

## The role you play

You are the **crew medical officer on a Mars surface base**. You are **not a physician** and have had basic
medical training only. Earth is behind the Sun, so you cannot ask Houston. LANDFALL is the only help on screen.

## How to run it

- **Think out loud.** Say what you are looking for, what you expect, and what surprises you. That is the data.
- **There are no wrong answers.** If something is confusing, the app is wrong, not you.
- **Do not read the Method, Provenance or Data pages first.** Use the app the way a busy crew member would.
- **After each task**, give your Bedford workload rating (next section) and write one or two lines in the results table.
- The observer writes down how long each task took and counts any step that went wrong or was left unfinished.
  You do nothing for that.
- **At the end**, fill in the NMSUS questionnaire, the open questions and the consent line.

## Tasks

| # | Task | What to note |
|---|---|---|
| T0 | Open the link. **Do not click anything for 30 seconds.** Then say: what is happening, and what should the crew do right now? | Your exact words. Was it clear within 30 s? |
| T1 | **Do what LANDFALL tells you about the radiation storm.** Open the case and go through its steps until it asks for an outcome. | Did you find where to start? Any step you did not understand? |
| T2 | Crewmember **CM-3** has low urine output. **Find out what LANDFALL wants you to do first, and do it.** | What did it ask you before telling you to drink more? Was that clear? |
| T3 | Switch the environment (ENV, top bar) to the **International Space Station**. **What changed for CM-2?** | Did you notice what changed and why? |
| T4 | Do **today's Noon Sight** check for yourself. Use the **30-second demo** of the reaction test. | Anything awkward on your device? Anything you did not want to answer? |
| T5 | Imagine **the screen has failed.** Open the paper card for the storm (Cases → print card, or the address `#/card`). **Could you follow it without the app?** | What would you need that the card does not give you? |

## After each task: the Bedford Workload Scale

Answer three questions, in this order (HIDP, NASA/TP-2014-218556, section 4.3.2.1; OCHMO-TB-032):

1. "Was it possible to complete the task?" If **no**, your rating is **10**.
2. "Was workload tolerable for the task?" If **no**, choose **7, 8 or 9**.
3. Was workload satisfactory without reduction? If **no**, choose **4, 5 or 6**. If **yes**, choose **1, 2 or 3**.

Within a group, a lower number means more spare capacity was left: attention you could still have given to a
second task at the same time. The official wording of all ten levels is in HIDP
[Figure 4.3.2-1](https://ntrs.nasa.gov/api/citations/20140009559/downloads/20140009559.pdf#page=46) (PDF page 46).
Use it if you can.

**Pass marks ([V2 5007]):** "Bedford Workload Scale ratings of 3 or less for nominal tasks and 6 or less for tasks
performed under degraded system conditions." T5 (the screen has failed) is the degraded task. T0 to T4 are
nominal.

## At the end: the NMSUS questionnaire

Rate each statement from **1 (strongly disagree)** to **5 (strongly agree)**. The eight statements are NASA's,
word for word (Vol 2 Rev F,
[Figure 5.1-1](https://www.nasa.gov/wp-content/uploads/2025/05/nasa-std-3001-vol-2.pdf#page=42)).

| # | Statement | 1–5 |
|---|---|---|
| Q1 | I thought the system was easy to use. | |
| Q2 | I think that I would need technical support to be able to use this system. | |
| Q3 | I found the various functions in this system were well integrated. | |
| Q4 | I thought there was too much inconsistency in this system. | |
| Q5 | I imagine that most trained crewmembers would learn to use this system very quickly. | |
| Q6 | I found the system very cumbersome to use. | |
| Q7 | I felt very confident using the system. | |
| Q8 | I needed a lot of training on this system in order to get going. | |

**Scoring (Figure 5.1-1):** NMSUS = 3.125 * ((Q1-1)+(5-Q2)+(Q3-1)+(5-Q4)+(Q5-1)+(5-Q6)+(Q7-1)+(5-Q8))

The score runs from 0 to 100. **Pass mark ([V2 10001]):** "an average satisfaction score of 85 or higher".

**One more question, ours rather than NASA's:** how much would you **trust** LANDFALL's guidance in a real
emergency? (1 = not at all, 5 = completely) ……

## For the observer: design-induced errors

For each task, count the task steps (each instruction in the task or on screen that the tester acts on), the
erroneous steps and the incomplete steps. [V2 10002] rationale: "The percentage of errors (erroneous task
steps) for each user is calculated by dividing the number of erroneous task steps and incomplete task steps by
the total number of task steps and multiplying the result by 100."

**Maximum observed error rates (Table 5.1-1):**

| Type of error | Maximum observed error rate |
|---|---|
| Catastrophic error | 0% |
| Non-catastrophic errors per user per task | 5% |
| Non-catastrophic errors per step per task | 10% |

Our reading (a design choice, not NASA's definition): a step counts as potentially catastrophic if, in a real
event, it would have left a crewmember unprotected, for example not starting the shelter in T1 or skipping the
red-flag question in T2.

## Open questions

1. Three things that confused you, slowed you down or worried you.
2. The one change you would make first.
3. Anything that felt wrong, alarming or misleading.

## Consent

"I agree that team Isaac Clarke may report my ratings, timings and comments, without my contact details, in the
project submission."  Initials: ……  ·  Date: ……

## Results (fill in)

**Date and time:** ……  ·  **Device and browser:** ……  ·  **Total time:** ……

| # | Done? (yes / partly / no) | Time | Bedford (1–10) | Steps / erroneous / incomplete | What happened, in your words |
|---|---|---|---|---|---|
| T0 | | | | | |
| T1 | | | | | |
| T2 | | | | | |
| T3 | | | | | |
| T4 | | | | | |
| T5 | | | | | |

**NMSUS:** Q1 … Q8 = …… → score ……  ·  **Trust (ours):** ……

---

*This is a small, informal usability check by one tester from our own team, untrained on the system. It is not a
NASA verification. We report its findings and scores as they are, including any that miss NASA's pass marks and
anything we could not fix in time.*

**Sources.** NASA-STD-3001 Vol 2 Rev F (approved 2026-07-14): section 5.1.2 [V2 10001] and Figure 5.1-1; section
5.1.3 [V2 10002] and Table 5.1-1; section 5.1.4 [V2 5007]
(https://www.nasa.gov/wp-content/uploads/2025/05/nasa-std-3001-vol-2.pdf). NASA/TP-2014-218556, *Human
Integration Design Processes* (HIDP), section 4.3.2 and Figure 4.3.2-1
(https://ntrs.nasa.gov/api/citations/20140009559/downloads/20140009559.pdf). OCHMO-TB-032 Rev C, *Cognitive
Workload Assessment Methods*, NASA-STD-3001 technical brief
(https://www.nasa.gov/wp-content/uploads/2023/12/ochmo-tb-032-cognitive-workload.pdf).
