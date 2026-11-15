# Third-party software, fonts, model files and data

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

## Model files (shipped)

| Work | License | Use |
|---|---|---|
| potion-base-8M by MinishLab ([minishlab/potion-base-8M](https://huggingface.co/minishlab/potion-base-8M), revision `bf8b056651a2c21b8d2565580b8569da283cab23`), shipped as an 8-bit copy in `web/public/assets/models/potion-base-8M-bf8b0566/`: `embeddings.i8`, `scales.f32` and `vocab.txt` (7,896,970 B together, 7.9 MB), with `LICENSE.txt` and `SOURCE.md` | MIT (the model card declares `license: mit`; the MIT notice is in `LICENSE.txt` beside the files) | Ranks the 57 frozen NASA-STD-3001 requirements on #/method?s=find, outside the decision path. Not precached: fetched from this site on the first search. `SOURCE.md` records the source and output SHA-256s and the command that made the copy (`tools/find/quantize.py`, standard library only) |

The model is distilled from **BAAI/bge-base-en-v1.5** (MIT, per its model card). Its training set,
**minishlab/tokenlearn-c4-en-bge-base-v1.5** (named in the potion-base-8M model card), has a licence we did not
verify: the metadata of its dataset card, read on 15 Nov 2026, declares none.

## Python

| Package | License | Use |
|---|---|---|
| httpx | BSD-3-Clause | Build-time fetching (ingest only) |
| pdfminer.six | MIT | ToUnicode-aware PDF text extraction (ingest only) |
| beautifulsoup4 | MIT | HTML parsing of official resource pages (ingest only) |
| pytest | MIT | Tests |

`engine/` has **no** third-party dependencies.

## Build-time tools, not shipped

Used only by `tools/nearest/rank.py` and by `tools/find/` (`make_vectors.py`, `unicode_tables.py`), each run in a
throwaway `uv run --isolated --no-project` environment: not project dependencies (`pyproject.toml` and `uv.lock`
do not list them), not in the build, and never run by the app. Versions as resolved for `tools/nearest` on
15 Nov 2026 (`tools/find` pins tokenizers 0.23.3 and model2vec 0.10.0); licences as each package's metadata or
licence file states them, read on 15 Nov 2026.

| Tool | Version | License | Use |
|---|---|---|---|
| potion-base-8M (MinishLab), full-precision files | revision `bf8b0566`; `model.safetensors` 30,236,760 B, SHA-256 `f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2` | MIT (model card) | Ranks NASA-STD-3001 requirements near each searched negative (`tools/nearest`); source of the shipped 8-bit copy (`tools/find`) |
| model2vec | 0.10.0 | MIT | Loads the model (`tools/nearest`); full-precision cross-check (`tools/find`) |
| numpy | 2.5.4 | BSD-3-Clause (the wheel's metadata: BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0) | Cosine ranking; reference vectors |
| tokenizers | 0.23.3 | Apache-2.0 | Tokenization; the frozen reference token IDs the TypeScript tokenizer is tested against |
| safetensors | 0.8.0 | Apache-2.0 | Weight file format |

Their own dependencies include huggingface_hub 2.4.0 (Apache-2.0), joblib 1.6.0 (BSD-3-Clause) and
tqdm 4.70.1 (MPL-2.0 AND MIT). The commands, hashes and measurements are in `tools/nearest/README.md` and
`tools/find/README.md`.

## Data

NASA and NOAA data are U.S. Government works. NASA does not endorse this project.
Canadian Space Agency (CSA) content is quoted only in short factual extracts, with attribution
and a link to the original page (never the full text), per the challenge's instruction to
comply with the data-use terms of non-U.S. Government websites.
