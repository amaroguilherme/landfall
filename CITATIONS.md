# Citations

These are the resources LANDFALL uses. NASA does not endorse this project.
The generated section at the end is rebuilt from the shipped data and rules by
`uv run python -m ingest.citations` (also run by `uv run python -m ingest --all`).
It can never list less than the app actually uses.

## Challenge

- NASA Space Apps Challenge 2026. *Create Health Monitoring Software for Astronauts on Space Missions.*
  https://www.spaceappschallenge.org/2026/challenges/health-monitoring-software/

## Official challenge resources

Each one has an ingest adapter (`ingest/hrp.py`).

- NASA Human Research Program. *5 Hazards of Human Spaceflight.* https://www.nasa.gov/hrp/hazards/
- NASA Human Research Program. *Risks of Human Spaceflight.* https://www.nasa.gov/hrp/risks/
- NASA Human Research Program. *Ongoing HRP Research in Space.* https://www.nasa.gov/hrp/ongoing-hrp-research/
- Canadian Space Agency (2026-02-26). *Monitoring radiation for astronaut health.*
  https://www.asc-csa.gc.ca/eng/news/articles/2026/2026-02-26-monitoring-radiation-astronaut-health.asp
- Canadian Space Agency. *Why do we conduct science experiments in space?*
  https://www.asc-csa.gc.ca/eng/iss/science/why-do-we-conduct-science-experiments-in-space.asp

## NASA standards

Requirement text is extracted verbatim with a ToUnicode-aware PDF parser and checked by tests.

- NASA Office of the Chief Health and Medical Officer. *NASA-STD-3001, NASA Spaceflight Human-System
  Standard, Volume 1: Crew Health, Revision C.* Approved 2023-09-15.
  https://www.nasa.gov/wp-content/uploads/2023/11/nasa-std-3001-vol-1-rev-c-with-signature.pdf
  (SHA-256 `e65882af9c9a9861b520268f739baadba08f6225feb14489ff7c46442de26ce9`).
- NASA Office of the Chief Health and Medical Officer. *NASA-STD-3001, Volume 2: Human Factors,
  Habitability, and Environmental Health, Revision F.* Approved 2026-07-14 (supersedes Revision E, 2025-05-01).
  https://www.nasa.gov/wp-content/uploads/2025/05/nasa-std-3001-vol-2.pdf
  (SHA-256 `2bf853a84de99ce4a14f8a8b58c7566068826e7d399f7ed284507e743f6e7155`).
- NASA OCHMO. *Human Spaceflight Standards* (download page).
  https://www.nasa.gov/ochmo/human-spaceflight-and-aviation-standards/

## NASA reports

- Sibonga JD, Pietrzyk R. *Evidence Report: Risk of Renal Stone Formation.* NASA Johnson Space Center,
  2017-05-15. NTRS 20170004709. https://ntrs.nasa.gov/citations/20170004709
- NASA Human Research Program. *Human Research Roadmap*, Risk 81 "Risk of Renal Stone Formation"
  (last published 2025-05-13) and the Explore tree. https://humanresearchroadmap.nasa.gov/Explore/
- Maida JC. *Introduction to the Solid State Based Interior Lighting System for ISS.* NASA Johnson Space
  Center. NTRS 20160005080. https://ntrs.nasa.gov/citations/20160005080
- NASA Exploration Medical Capability. *Medical System Concept of Operations for Mars Exploration
  Mission-11.* NTRS 20200001715. https://ntrs.nasa.gov/citations/20200001715

## The navigation anchor

- NASA Space Station Research. *Deep Space Navigation: Tool Tested as Emergency Navigation Device*
  (M. Gaskill, ISS Program Science Office, 2018-06-19; quotes principal investigator Greg Holt). Archived copy:
  https://web.archive.org/web/20180831201933/https://www.nasa.gov/mission_pages/station/research/news/Sextant_ISS/
- ISS investigation 7646, *Sextant Navigation for Exploration Missions* (PI Greg N. Holt, NASA JSC).
- Holt GN, Wood BA. *Sextant Navigation on the International Space Station: A Human Space Exploration Demo.*
  AAS 19-064, 2019. NTRS 20190001296. https://ntrs.nasa.gov/citations/20190001296

## Wearable reference hardware

- Canadian Space Agency Bio-Monitor (Hexoskin Astroskin), flown on the ISS: the channel rates, pitfalls and recorder
  facts shown on `#/band` were read on 2026-11-14 in these public sources (not frozen in this build):
  NASA, ISS Daily Summary Report, 2019-02-28 (Bio-Monitor),
  https://blogs.nasa.gov/stationreport/2019/02/28/iss-daily-summary-report-2-28-2019/ ·
  Toscano W, Cowings P, Sullivan P, et al. Wearable Biosensor Monitor to Support Autonomous Crew Health and Readiness
  to Perform. NASA HRP Investigators' Workshop, 2017. NTRS 20190001996, https://ntrs.nasa.gov/citations/20190001996 ·
  Hexoskin, Astroskin Device (product page), https://hexoskin.com/products/astroskin-device ·
  Hexoskin API documentation, https://api.hexoskin.com/docs/ (datatype registry:
  https://api.hexoskin.com/docs/resource/datatype/; data resource: https://api.hexoskin.com/docs/resource/data/).
- Schäfer A, Vagedes J. How accurate is pulse rate variability as an estimate of heart rate variability? A review on
  studies comparing photoplethysmographic technology with an electrocardiogram. *Int J Cardiol* 2013;166(1):15-29.
  doi:10.1016/j.ijcard.2012.03.119. PMID 22809539 (the band's PPG-derived heart rate and pulse-rate variability).
- US Food and Drug Administration. De Novo classification request for ECG App (DEN180044), Apple Inc., De Novo date
  August 14, 2018: decision summary. https://www.accessdata.fda.gov/cdrh_docs/reviews/DEN180044.pdf (the band's
  wrist-and-finger spot ECG).
- Part datasheets and product pages are cited per part in `hardware/sensor-map.json`.

## Interoperability standards

- HL7 International. *FHIR Release 4* (vital-signs profile). https://hl7.org/fhir/R4/
- Regenstrief Institute. *LOINC.* https://loinc.org/ · *UCUM, The Unified Code for Units of Measure.* https://ucum.org/

## Design system

- NASA. *Horizon Design System* (`@nasa-hds/core` v0.10.0, CC0-1.0). https://github.com/nasa/hds-core

## Statistics

- Crawford JR, Howell DC. Comparing an individual's test score against norms derived from small samples.
  *Clin Neuropsychol* 1998;12(4):482-486. doi:10.1076/clin.12.4.482.7241
- Crawford JR, Garthwaite PH, Azzalini A, Howell DC, Laws KR. Testing for a deficit in single-case studies:
  effects of departures from normality. *Neuropsychologia* 2006;44(4):666-677. doi:10.1016/j.neuropsychologia.2005.06.001
- Jacobson NS, Truax P. Clinical significance: a statistical approach to defining meaningful change in
  psychotherapy research. *J Consult Clin Psychol* 1991;59(1):12-19.

## Ephemerides and space weather

- JPL Horizons On-Line Ephemeris System, NASA Jet Propulsion Laboratory. https://ssd.jpl.nasa.gov/horizons/
- NOAA Space Weather Prediction Center. *NOAA Space Weather Scales.* https://www.swpc.noaa.gov/noaa-scales-explanation

## Use of AI

LANDFALL was built by Guilherme Amaro with Claude Code (Anthropic) as a coding assistant. Claude Code
wrote code, ran the build-time data ingestion and verification, and drafted documentation. No AI model
runs in the product's decision path.

## Generated from the shipped data

<!-- BEGIN GENERATED: do not edit by hand; run `uv run python -m ingest.citations` -->

### Frozen data snapshots (`web/public/data/`)

**Canadian Space Agency**

- Canadian Space Agency. "Monitoring radiation for astronaut health." News article, 2026-02-26 (date modified 2026-02-26). https://www.asc-csa.gc.ca/eng/news/articles/2026/2026-02-26-monitoring-radiation-astronaut-health.asp (accessed 2026-11-14). *(snapshots: `hrp_csa_radiation`)*
- Canadian Space Agency. "Why do we conduct science experiments in space?" Web page, first issued 2015-06-02, date modified 2025-10-28. https://www.asc-csa.gc.ca/eng/iss/science/why-do-we-conduct-science-experiments-in-space.asp (accessed 2026-11-14). *(snapshots: `hrp_csa_science`)*

**LANDFALL project (simulated scenario generator)**

- LANDFALL simulated crew scenario (seed 20261114), ingest/sim_crew.py, https://github.com/amaroguilherme/landfall. Means calibrated against Barger et al. 2014 (PMID 25127232) and Basner et al. 2011 (PMID 22025811); day-to-day SDs from Flynn-Evans et al. 2016 (PMID 28725719), Quer et al. 2020 (PMID 32023264), Nayan et al. 2012 (PMID 22396364) and Selvin et al. 2007 (PMID 17646610) where published, design choices elsewhere (listed per variable), with context from Knutson et al. 2007 (PMID 17580601), Huang & Redline 2019 (PMID 31167888), Basner et al. 2018 (PMID 29126328), Bellenger et al. 2022 (PMID 36146073), Norsk et al. 2015 (PMID 25774397), Matsui et al. 2012 (PMID 22547439) and Juhanoja et al. 2017 (PMID 28193705); SPE shape from NOAA NCEI GOES-07 EPS (October 1989); Mars-surface baseline from NASA CCMC iSWA MSL RAD; conjunction window modelled from JPL Horizons geometry when present. *(snapshots: `sim_crew`)*

**NASA Community Coordinated Modeling Center (CCMC)**

- NASA Community Coordinated Modeling Center. DONKI (Space Weather Database Of Notifications, Knowledge, Information), SEP web service, https://api.nasa.gov/DONKI/SEP?startDate=2024-01-01&endDate=2024-02-29&api_key=<NASA_API_KEY>. Accessed 2026-11-14. *(snapshots: `swpc_sep_events`)*

**NASA GSFC Community Coordinated Modeling Center (CCMC), iSWA HAPI server**

- NASA GSFC Community Coordinated Modeling Center (CCMC), Integrated Space Weather Analysis system (iSWA), HAPI dataset 'CRaTER' ('CRaTER Dose Rates', startDate 2009-06-26T20:06:35Z, stopDate 2026-10-07T23:30:00Z), HAPI server https://iswa.gsfc.nasa.gov/IswaSystemWebApp/hapi, retrieved 2026-11-14T21:58:12Z. *(snapshots: `hapi_crater_dose`)*
- NASA GSFC Community Coordinated Modeling Center (CCMC), Integrated Space Weather Analysis system (iSWA), HAPI dataset 'msl_rad_dosimetry' ('MSL RAD Dosimetry', startDate 2011-11-20T18:29:59Z, stopDate 2026-11-12T16:19:14Z), HAPI server https://iswa.gsfc.nasa.gov/IswaSystemWebApp/hapi, retrieved 2026-11-14T21:58:12Z. *(snapshots: `hapi_msl_rad_dose`)*

**NASA Goddard Space Flight Center, Space Physics Data Facility (SSCWeb), served via hapi-server.org**

- NASA GSFC Space Physics Data Facility, Satellite Situation Center Web (SSCWeb), ISS ephemeris (dataset 'iss', cadence PT60S, startDate 1998-11-21T00:00:00Z, stopDate 2026-11-29T00:00:00Z), accessed through the SSCWeb HAPI server https://hapi-server.org/servers/SSCWeb/hapi (HAPI 2.0), retrieved 2026-11-14T21:58:12Z. https://sscweb.gsfc.nasa.gov/ *(snapshots: `hapi_iss_track`)*

**NASA Human Research Program**

- NASA Human Research Program. "5 Hazards of Human Spaceflight." NASA, page updated 2026-06-12. https://www.nasa.gov/hrp/hazards/ (accessed 2026-11-14); plus the five linked hazard pages listed in access_urls. *(snapshots: `hrp_hazards`)*
- NASA Human Research Program. "Ongoing HRP Research in Space." NASA. https://www.nasa.gov/hrp/ongoing-hrp-research/ (accessed 2026-11-14); investigation pages and the linked Polaris Dawn article (NASA, 2024-09-10) in access_urls. *(snapshots: `hrp_research`)*
- NASA Human Research Program. "Risks of Human Spaceflight." NASA. https://www.nasa.gov/hrp/risks/ (accessed 2026-11-14); plus each linked nasa.gov/reference/risk-... page in access_urls. *(snapshots: `hrp_risks`)*
- NASA Human Research Program. "Human Research Roadmap: Explore" (Element-Risk-Gap-Task tree). https://humanresearchroadmap.nasa.gov/Explore/ (accessed 2026-11-14); per-risk pages https://humanresearchroadmap.nasa.gov/risks/?i=<id> for ids [81, 77, 100, 96, 85, 179, 99, 95, 175]. *(snapshots: `hrp_roadmap`)*

**NASA Jet Propulsion Laboratory, Solar System Dynamics Group**

- Giorgini, JD and JPL Solar System Dynamics Group, NASA/JPL Horizons On-Line Ephemeris System, <https://ssd.jpl.nasa.gov/horizons/>, data retrieved 2026-Nov-14. Observer table, target Mars (499), center Earth geocenter (500@399), quantities 20, 21, 23, daily. Accessed through the Horizons API (https://ssd.jpl.nasa.gov/api/horizons.api), signature "NASA/JPL Horizons API" version 1.2. *(snapshots: `horizons_mars_comms`)*
- Giorgini, JD and JPL Solar System Dynamics Group, NASA/JPL Horizons On-Line Ephemeris System, <https://ssd.jpl.nasa.gov/horizons/>, data retrieved 2026-Nov-14. Observer table, target Moon (301), center Earth geocenter (500@399), quantities 20, 21, daily. Accessed through the Horizons API (https://ssd.jpl.nasa.gov/api/horizons.api), signature "NASA/JPL Horizons API" version 1.2. *(snapshots: `horizons_moon_comms`)*

**NASA Office of the Chief Health and Medical Officer (OCHMO)**

- National Aeronautics and Space Administration, Office of the Chief Health and Medical Officer. NASA-STD-3001, Volume 1, Revision C: NASA Spaceflight Human-System Standard, Volume 1: Crew Health. Approved 2023-09-15. https://www.nasa.gov/wp-content/uploads/2023/11/nasa-std-3001-vol-1-rev-c-with-signature.pdf (retrieved 2026-11-14; SHA-256 e65882af9c9a9861b520268f739baadba08f6225feb14489ff7c46442de26ce9). *(snapshots: `std_vol1_requirements`)*
- NASA Office of the Chief Health and Medical Officer. NASA-STD-3001, NASA Spaceflight Human-System Standard, Volume 2: Human Factors, Habitability, and Environmental Health, Revision F. Approved 2026-07-14 (supersedes Revision E, 2025-05-01). https://www.nasa.gov/wp-content/uploads/2025/05/nasa-std-3001-vol-2.pdf (landing page https://www.nasa.gov/reference/nasa-std-3001v2/). sha256 2bf853a84de99ce4a14f8a8b58c7566068826e7d399f7ed284507e743f6e7155. *(snapshots: `std_vol2_requirements`)*

**NASA Open Science Data Repository (OSDR)**

- NASA Open Science Data Repository (OSDR). OSD-569: Whole Blood Measurements from the SpaceX Inspiration4 Mission (RNA-seq, epitranscriptome, WGS, clonal hematopoiesis, CBC). Study version 4, submitted 2023-08-29, publicly released 2024-05-14. https://osdr.nasa.gov/bio/repo/data/studies/OSD-569 (no dataset DOI is stated in the OSDR metadata). Investigators listed by OSDR: Christopher Mason (principal investigator); Eliah Overbey (co-investigator); Kirill Grigorev (formal analysis role); Theodore Nelson (formal analysis role); J. Sebastian Garcia Medina (formal analysis role). Publications listed by OSDR: The Space Omics and Medical Atlas (SOMA) and international astronaut biobank (doi:10.1038/s41586-024-07639-y); Direct RNA sequencing of astronauts reveals spaceflight-associated m6A increases and hematopoietic transcriptional responses (doi:10.1038/s41467-024-48929-3); Collection of Biospecimens from the Inspiration4 Mission Establishes the Standards for the Space Omics and Medical Atlas (SOMA) (doi:10.1038/s41467-024-48806-z); Genome and clonal hematopoiesis stability contrasts with immune, cfDNA, mitochondrial, and telomere length changes during short duration spaceflight. (doi:10.1093/pcmedi/pbae007); CAMbank: cfDNA BCT Field Processing v1 (doi:10.17504/protocols.io.6qpvr33yovmk/v1). *(snapshots: `osdr_cbc`)*
- NASA Open Science Data Repository (OSDR). OSD-575: SpaceX Inspiration4 Blood Serum Metabolic Panel and Immune/Cardiac Cytokine Arrays (Comprehensive Metabolic Panel and Multiplex). Study version 3, submitted 2022-12-05, publicly released 2024-05-14. https://osdr.nasa.gov/bio/repo/data/studies/OSD-575 (no dataset DOI is stated in the OSDR metadata). Investigators listed by OSDR: Christopher Mason (principal investigator); Eliah Overbey (co-investigator); Kirill Grigorev (formal analysis role); Theodore Nelson (formal analysis role). Publications listed by OSDR: The Space Omics and Medical Atlas (SOMA) and international astronaut biobank (doi:10.1038/s41586-024-07639-y); Collection of Biospecimens from the Inspiration4 Mission Establishes the Standards for the Space Omics and Medical Atlas (SOMA) (doi:10.1038/s41467-024-48806-z); CAMbank: SST Field Processing v1 (doi:10.17504/protocols.io.81wgbxxo1lpk/v1). *(snapshots: `osdr_cmp`, `osdr_cytokines`)*
- NASA Open Science Data Repository (OSDR). OSD-656: SpaceX Inspiration4 Urine Inflammation Panel (Multiplex, NULISAseq). Study version 2, submitted 2023-08-31, publicly released 2024-05-14. https://osdr.nasa.gov/bio/repo/data/studies/OSD-656 (no dataset DOI is stated in the OSDR metadata). Investigators listed by OSDR: Eliah Overbey (co-investigator); Christopher Mason (principal investigator). Publications listed by OSDR: The Space Omics and Medical Atlas (SOMA) and international astronaut biobank (doi:10.1038/s41586-024-07639-y); Collection of Biospecimens from the Inspiration4 Mission Establishes the Standards for the Space Omics and Medical Atlas (SOMA) (doi:10.1038/s41467-024-48806-z). *(snapshots: `osdr_urine`)*

**NASA Space Radiation Analysis Group (JSC), via NASA GSFC Space Physics Data Facility CDAWeb**

- Semones, E. (contact), NASA Space Radiation Analysis Group / Johnson Space Center. ISS_DOSANL_TEPC: Experiment Data, ISS TEPC (TEPC serial number 1003, analysis software version 3.1), 2010-04-29 to 2018-04-11. NASA GSFC Space Physics Data Facility, CDAWeb HAPI server https://cdaweb.gsfc.nasa.gov/hapi, retrieved 2026-11-14T21:58:12Z. DOI listed by CDAWeb: https://doi.org/10.48322/0ba1-1764 (see caveat on its metadata). https://cdaweb.gsfc.nasa.gov/misc/NotesI.html#ISS_DOSANL_TEPC *(snapshots: `hapi_iss_tepc`)*

**NOAA National Centers for Environmental Information (NCEI)**

- NOAA National Centers for Environmental Information (originating agency DOC/NOAA/NCEP/NWS/SWPC). GOES-07 Energetic Particle Sensor (EPS), 5-minute averages, 1989-10-01 to 1989-10-31, file g07_eps_5m_19891001_19891031.csv (created 2014-03-19), GOES Space Environment Monitor archive, https://www.ncei.noaa.gov/data/goes-space-environment-monitor/access/avg/1989/10/goes07/csv/g07_eps_5m_19891001_19891031.csv. Accessed 2026-11-14. *(snapshots: `swpc_spe_replay`)*

**NOAA Space Weather Prediction Center (SWPC)**

- NOAA Space Weather Prediction Center. GOES primary integral proton flux, 5-minute averages (integral-protons-6-hour.json and integral-protons-7-day.json), SWPC data service, https://services.swpc.noaa.gov/json/goes/primary/. Accessed 2026-11-14T15:17:52Z. *(snapshots: `swpc_protons_live`)*
- NOAA Space Weather Prediction Center. NOAA Space Weather Scales (Solar Radiation Storms, S1-S5). Web page https://www.swpc.noaa.gov/noaa-scales-explanation (served from www.spaceweather.gov) and PDF 'NOAA Space Weather Scales', dated December 11, 2023, https://www.swpc.noaa.gov/sites/default/files/images/NOAAscales.pdf. Accessed 2026-11-14. *(snapshots: `swpc_s_scale`)*

**NOAA Space Weather Prediction Center (formerly SESC); mirrored by NASA GSFC Solar Data Analysis Center**

- NOAA Space Environment Services Center (now NOAA SWPC). Solar Proton Events Affecting the Earth Environment, 1976 - present, Preliminary Listing. NASA GSFC Solar Data Analysis Center mirror, https://umbra.nascom.nasa.gov/SEP/. Accessed 2026-11-14. *(snapshots: `swpc_spe_list`)*

### Sources cited by the rules engine (`engine/rules/`)

- Anscombe FJ. The transformation of Poisson, binomial and negative-binomial data. Biometrika 1948;35(3-4):246-254. doi:10.1093/biomet/35.3-4.246
- BIPM. The International System of Units (SI Brochure), 9th edition, 2019: c = 299 792 458 m/s (exact, by definition).
- Barger LK, Flynn-Evans EE, Kubey A, Walsh L, Ronda JM, Wang W, Wright KP Jr, Czeisler CA. Prevalence of sleep deficiency and use of hypnotic drugs in astronauts before, during, and after spaceflight: an observational study. Lancet Neurol 2014;13(9):904-912. doi:10.1016/S1474-4422(14)70122-X. PMID 25127232
- Basner M, Mollicone D, Dinges DF. Validity and sensitivity of a brief psychomotor vigilance test (PVT-B) to total and partial sleep deprivation. Acta Astronaut 2011;69(11-12):949-959. doi:10.1016/j.actaastro.2011.07.015. PMID 22025811
- Crawford JR, Garthwaite PH, Azzalini A, Howell DC, Laws KR. Testing for a deficit in single-case studies: effects of departures from normality. Neuropsychologia 2006;44(4):666-677. doi:10.1016/j.neuropsychologia.2005.06.001. PMID 16046228
- Crawford JR, Howell DC. Comparing an individual's test score against norms derived from small samples. Clin Neuropsychol 1998;12(4):482-486. doi:10.1076/clin.12.4.482.7241
- Jacobson NS, Truax P. Clinical significance: a statistical approach to defining meaningful change in psychotherapy research. J Consult Clin Psychol 1991;59(1):12-19. doi:10.1037//0022-006x.59.1.12. PMID 2002127
- Lang T, LeBlanc A, Evans H, Lu Y, Genant H, Yu A. Cortical and trabecular bone mineral loss from the spine and hip in long-duration spaceflight. J Bone Miner Res 2004;19(6):1006-1012. doi:10.1359/JBMR.040307. PMID 15125798
- Maida JC. Introduction to the Solid State Based Interior Lighting System for ISS. NASA Johnson Space Center presentation, 2014-04-07. NTRS 20160005080
- NASA HRP Evidence Report: Risk of Renal Stone Formation (Sibonga & Pietrzyk, approved May 15, 2017; NTRS 20170004709) https://ntrs.nasa.gov/citations/20170004709
- NASA HRP Evidence Report: Risk of Renal Stone Formation (Stratton, Lumpkins & Antonsen, approved September 23, 2024; NTRS 20240012429) https://ntrs.nasa.gov/citations/20240012429
- NASA Human Research Roadmap. Risk of Renal Stone Formation (HRR risk 81), risk statement. https://humanresearchroadmap.nasa.gov/risks/?i=81
- NASA Open Science Data Repository (OSDR). OSD-575: SpaceX Inspiration4 Blood Serum Metabolic Panel and Immune/Cardiac Cytokine Arrays (Comprehensive Metabolic Panel and Multiplex). Study version 3, submitted 2022-12-05, publicly released 2024-05-14. https://osdr.nasa.gov/bio/repo/data/studies/OSD-575 (no dataset DOI is stated in the OSDR metadata). Investigators listed by OSDR: Christopher Mason (principal investigator); Eliah Overbey (co-investigator); Kirill Grigorev (formal analysis role); Theodore Nelson (formal analysis role). Publications listed by OSDR: The Space Omics and Medical Atlas (SOMA) and international astronaut biobank (doi:10.1038/s41586-024-07639-y); Collection of Biospecimens from the Inspiration4 Mission Establishes the Standards for the Space Omics and Medical Atlas (SOMA) (doi:10.1038/s41467-024-48806-z); CAMbank: SST Field Processing v1 (doi:10.17504/protocols.io.81wgbxxo1lpk/v1).
- NASA-STD-3001 Vol. 1 Rev. C https://www.nasa.gov/wp-content/uploads/2023/11/nasa-std-3001-vol-1-rev-c-with-signature.pdf
- NASA-STD-3001 Vol. 2 Rev. F https://www.nasa.gov/wp-content/uploads/2025/05/nasa-std-3001-vol-2.pdf
- NOAA Space Weather Scales (Solar Radiation Storms) https://www.swpc.noaa.gov/noaa-scales-explanation
- Whitson PA, Pietrzyk RA, Jones JA, Nelman-Gonzalez M, Hudson EK, Sams CF. Effect of potassium citrate therapy on the risk of renal stone formation during spaceflight. J Urol 2009;182(5):2490-2496. doi:10.1016/j.juro.2009.07.010. PMID 19765769
- Williams DR. Moon Fact Sheet. NASA NSSDCA (last updated 11 January 2024): apogee 0.4055 x 10^6 km (mean apogee).
- Williams DR. Moon Fact Sheet. NASA NSSDCA (last updated 11 January 2024): perigee 0.3633 x 10^6 km (mean perigee).
- Williams DR. Moon Fact Sheet. NASA Space Science Data Coordinated Archive, Goddard Space Flight Center (last updated 11 January 2024): semimajor axis 0.3844 x 10^6 km.

<!-- END GENERATED -->
