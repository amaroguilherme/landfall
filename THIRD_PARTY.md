# Third-party software, fonts and data

LANDFALL is licensed under Apache-2.0. It depends on the following third-party works,
each under its own license. This file is kept current as dependencies are added.

## Front end (npm)

| Package | License | Use |
|---|---|---|
| react, react-dom | MIT | UI |
| vite | MIT | Build tool |
| typescript | Apache-2.0 | Type checking |
| uplot | MIT | Canvas time-series charts |
| @nasa-hds/core | CC0-1.0 | NASA Horizon Design System tokens |

## Fonts

| Font | License |
|---|---|
| Inter | SIL Open Font License 1.1 |
| Public Sans | SIL Open Font License 1.1 |
| DM Mono | SIL Open Font License 1.1 |

## Python

| Package | License | Use |
|---|---|---|
| httpx | BSD-3-Clause | Build-time fetching (ingest only) |
| pdfminer.six | MIT | ToUnicode-aware PDF text extraction (ingest only) |
| beautifulsoup4 | MIT | HTML parsing of official resource pages (ingest only) |
| pytest | MIT | Tests |

`engine/` has **no** third-party dependencies.

## Data

NASA and NOAA data are U.S. Government works. NASA does not endorse this project.
Canadian Space Agency (CSA) content is quoted only in short factual extracts, with attribution
and a link to the original page (never the full text), per the challenge's instruction to
comply with the data-use terms of non-U.S. Government websites.
