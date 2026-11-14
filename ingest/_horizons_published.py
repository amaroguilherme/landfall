"""NASA/JPL published Mars solar-conjunction command-moratorium dates (calibration data).

Every quote below was read in the raw HTML of the cited page on 2026-11-14. The
adapter re-fetches each page at build time and FAILS if the quote is no longer
there, so these dates cannot drift away from their source silently.

Selection rule (applied before looking at any residual): use the window NASA/JPL
states for the Mars fleet as a whole ("most missions", the relay orbiters).
Mission-specific windows and windows that are not command moratoria are kept for
transparency with used_in_calibration = False and the reason.
"""

from __future__ import annotations

from datetime import date

PUBLISHED_MORATORIA: list[dict] = [
    {
        "id": "2013_orbiters",
        "conjunction": "2013 April",
        "start": date(2013, 4, 9), "end": date(2013, 4, 26),
        "used_in_calibration": True,
        "scope": "Odyssey and Mars Reconnaissance Orbiter (relay for both rovers); "
                 "Opportunity had the same April 9-26 window",
        "quote": "Transmissions from Earth to the orbiters will be suspended while Mars and the sun "
                 "are two degrees or less apart in the sky, from April 9 to 26, with restricted "
                 "commanding during additional days before and after.",
        "doc": "Sun in the Way Will Affect Mars Missions in April",
        "publisher": "NASA Jet Propulsion Laboratory", "published": "2013-03-20",
        "url": "https://www.jpl.nasa.gov/news/sun-in-the-way-will-affect-mars-missions-in-april/",
    },
    {
        "id": "2013_curiosity",
        "conjunction": "2013 April",
        "start": date(2013, 4, 4), "end": date(2013, 5, 1),
        "used_in_calibration": False,
        "exclusion_reason": "Mission-specific window (Curiosity's first conjunction, 27 days); "
                            "the same release gives April 9-26 for the orbiters and Opportunity.",
        "scope": "Curiosity only",
        "quote": "Curiosity's controllers plan to suspend commanding from April 4 to May 1.",
        "doc": "Sun in the Way Will Affect Mars Missions in April",
        "publisher": "NASA Jet Propulsion Laboratory", "published": "2013-03-20",
        "url": "https://www.jpl.nasa.gov/news/sun-in-the-way-will-affect-mars-missions-in-april/",
    },
    {
        "id": "2015_fleet",
        "conjunction": "2015 June",
        "start": date(2015, 6, 7), "end": date(2015, 6, 21),
        "used_in_calibration": True,
        "scope": "three Mars orbiters and two Mars rovers",
        "quote": "The teams running NASA's three active Mars orbiters and two Mars rovers will "
                 "refrain from sending commands to their spacecraft from about June 7 to June 21. "
                 "During that period, the sun will be within two degrees of Mars in Earth's sky.",
        "doc": "Mars Missions to Pause Commanding in June, Due to Sun",
        "publisher": "NASA Jet Propulsion Laboratory", "published": "2015-06-03",
        "url": "https://www.jpl.nasa.gov/news/mars-missions-to-pause-commanding-in-june-due-to-sun/",
    },
    {
        "id": "2017_fleet",
        "conjunction": "2017 July",
        "start": date(2017, 7, 22), "end": date(2017, 8, 1),
        "used_in_calibration": True,
        "scope": "three Mars orbiters and two Mars rovers",
        "quote": "NASA will refrain from sending commands to America's three Mars orbiters and two "
                 "Mars rovers during the period from July 22 to Aug. 1.",
        "doc": "For Moratorium on Sending Commands to Mars, Blame the Sun",
        "publisher": "NASA Jet Propulsion Laboratory", "published": "2017-07-14",
        "url": "https://www.jpl.nasa.gov/news/for-moratorium-on-sending-commands-to-mars-blame-the-sun/",
    },
    {
        "id": "2019_fleet",
        "conjunction": "2019 September",
        "start": date(2019, 8, 28), "end": date(2019, 9, 7),
        "used_in_calibration": True,
        "scope": "NASA Mars fleet",
        "quote": "This time, the hold on issuing commands — called a “command moratorium” "
                 "— will run from Aug. 28 to Sept. 7, 2019.",
        "doc": "What's Mars Solar Conjunction, and Why Does It Matter?",
        "publisher": "NASA", "published": "2019-08-23",
        "url": "https://www.nasa.gov/solar-system/whats-mars-solar-conjunction-and-why-does-it-matter/",
    },
    {
        "id": "2021_fleet",
        "conjunction": "2021 October",
        "start": date(2021, 10, 2), "end": date(2021, 10, 16),
        "used_in_calibration": True,
        "scope": "most NASA Mars missions (a few extended by a day or two)",
        "quote": "This year, most missions will stop sending commands between Oct. 2 and Oct. 16. "
                 "A few extend that commanding moratorium, as it’s called, a day or two in "
                 "either direction, depending on the angular distance between Mars and the Sun in "
                 "Earth’s sky.",
        "doc": "NASA’s Mars Fleet Lies Low With Sun Between Earth and Red Planet",
        "publisher": "NASA", "published": "2021-09-28",
        "url": "https://www.nasa.gov/solar-system/nasas-mars-fleet-lies-low-with-sun-between-earth-and-red-planet/",
    },
    {
        "id": "2023_fleet",
        "conjunction": "2023 November",
        "start": date(2023, 11, 11), "end": date(2023, 11, 25),
        "used_in_calibration": True,
        "scope": "NASA Mars fleet",
        "quote": "NASA will hold off sending commands to its Mars fleet for two weeks, from Nov. 11 "
                 "to 25, while Earth and the Red Planet are on opposite sides of the Sun.",
        "doc": "NASA’s Mars Fleet Will Still Conduct Science While Lying Low",
        "publisher": "NASA Jet Propulsion Laboratory", "published": "2023-11-10",
        "url": "https://www.jpl.nasa.gov/news/nasas-mars-fleet-will-still-conduct-science-while-lying-low/",
    },
    {
        "id": "2026_no_contact",
        "conjunction": "2026 January",
        "start": date(2025, 12, 29), "end": date(2026, 1, 16),
        "used_in_calibration": False,
        "exclusion_reason": "Not a command-moratorium statement: it gives the span with no contact "
                            "with any Mars mission. Shown as an out-of-sample comparison only.",
        "scope": "all NASA Mars missions (contact, not commanding)",
        "quote": "Mars solar conjunction – a period when Mars and Earth are on opposite sides "
                 "of the Sun – begins Monday, Dec. 29, and NASA will not have contact with any "
                 "Mars missions until Friday, Jan. 16.",
        "doc": "NASA Works MAVEN Spacecraft Issue Ahead of Solar Conjunction",
        "publisher": "NASA Science (MAVEN blog)", "published": "2025-12-23",
        "url": "https://science.nasa.gov/blogs/maven/2025/12/23/nasa-works-maven-spacecraft-issue-ahead-of-solar-conjunction/",
    },
]

# The angular criterion JPL itself printed (2013 and 2015 releases above): used only as an
# independent cross-check of the calibrated threshold, never as the threshold.
JPL_STATED_CRITERION_DEG = 2.0
JPL_STATED_CRITERION_IDS = ["2013_orbiters", "2015_fleet"]
