# tools/find: the model files and frozen references behind #/method?s=find

The Method page's last section, "Find it in NASA's words", searches the 57 NASA-STD-3001 requirements LANDFALL
froze. It shows two columns: a keyword search (BM25, no model) first, then a ranking by closeness in meaning by
one small open model, potion-base-8M (MinishLab, MIT). The model is a table of word-piece vectors. It cannot write
text. It ranks NASA's own sentences against your words. It writes nothing, decides nothing and reads no crew data,
and nothing else in LANDFALL reads its output. A fixed word list (`web/src/features/find/guard.ts`), not the
model, handles symptom, medication, diagnosis and cancer-risk words.

Nothing here is a project dependency. `quantize.py` uses only the standard library. The reference scripts run in an
isolated, throw-away environment:

    uv run --isolated --no-project --with tokenizers==0.23.3 --with numpy --with safetensors --with model2vec==0.10.0 ...

## Files

| file | what it does |
| --- | --- |
| `quantize.py` | Checks `model.safetensors` (30,236,760 B, SHA-256 `f65d0f32…`) and `tokenizer.json` (683,666 B, SHA-256 `e67e803f…`) of revision `bf8b0566`. Then it writes the 8-bit copy and `SOURCE.md` to `web/public/assets/models/potion-base-8M-bf8b0566/`. |
| `make_vectors.py` | Freezes the reference token IDs (`fixtures/tokens.json`) and int8 vectors, each frozen query's top 5, and the fp32 cross-check (`fixtures/vectors.json`). |
| `unicode_tables.py` | Reads the tokenizer's character classes off the Rust tokenizer, one code point at a time. It writes them to `web/src/features/find/unicode.ts` and a hash over every code point (`fixtures/codepoints.json`). |
| `strings.json` | The parity strings: 238 queries and 95 Unicode cases. `make_vectors.py` adds the 57 passages, 150 typo variants and the gold questions. They are test inputs only and tune nothing. |

Commands, from the repository root, with the model at `/tmp/lf-models/potion8m`:

    python3 -I tools/find/quantize.py /tmp/lf-models/potion8m web/public/assets/models/potion-base-8M-bf8b0566
    uv run --isolated --no-project --with tokenizers==0.23.3 python -I tools/find/unicode_tables.py \
      /tmp/lf-models/potion8m/tokenizer.json web/src/features/find
    uv run --isolated --no-project --with tokenizers==0.23.3 --with numpy --with safetensors --with model2vec==0.10.0 \
      python -I tools/find/make_vectors.py /tmp/lf-models/potion8m web/public/assets/models/potion-base-8M-bf8b0566 \
      web/public/data web/src/features/find/fixtures web/src/features/find/gold.json

## The 8-bit copy

The fp32 table is 28.8 MiB, which is over Cloudflare's 25 MiB per-file limit. Each of its 29,528 rows of 256 values
is stored as int8 with one float32 scale:

- scale = max|row| / 127, rounded to float32;
- q = floor(x / scale + 0.5), clipped to -127..127;
- the browser reads q × scale.

| file | bytes |
| --- | ---: |
| `embeddings.i8` | 7,559,168 |
| `scales.f32` | 118,112 |
| `vocab.txt` | 219,690 |

Together they are 7,896,970 B, or 7.9 MB. `SOURCE.md` records every SHA-256. Against fp32 model2vec 0.10.0 on the
same files, the cosine of the int8 passage vectors is at least 0.99997 on all 57 passages.

## Encode contract (TypeScript and the reference are identical)

1. **Special tokens.** `[PAD]`, `[UNK]`, `[CLS]`, `[SEP]` and `[MASK]` are matched in the raw text first,
   leftmost first, as the tokenizer's added vocabulary does (`normalized: false`).
2. **BertNormalizer**, in the Rust order:
   - clean_text: drop NUL, U+FFFD and the tokenizer's control, format and private-use classes; turn whitespace
     into a space;
   - pad the CJK Unified Ideographs blocks with spaces;
   - strip accents: NFD, then drop the tokenizer's Mn class;
   - lower-case each code point (Rust `char::to_lowercase`, so no final-sigma rule).

   The character classes come from `unicode.ts`, not from the browser's own (newer) Unicode tables. They were
   read off the tokenizer. NFD is the browser's, except for 21 code points that the tokenizer's older tables
   leave whole (`NO_NFD`).
3. **BertPreTokenizer**: split on whitespace, and make each punctuation character its own token (ASCII 33-47,
   58-64, 91-96, 123-126, and the tokenizer's Unicode P* classes).
4. **WordPiece**: greedy longest match, `##` for a continuation. A word over 100 code points (counted as
   `Array.from` does), or a word with no match, becomes `[UNK]`.
5. **What counts.** model2vec 0.10.0 cuts the text to 512 × int(median token length) = 3,072 code points. It
   tokenises the cut text, takes the first 512 IDs, then drops `[UNK]`. **`[UNK]` is ID 1 in this vocabulary**,
   not BERT's 100: potion-base-8M renumbers its 29,528 tokens. Five of the 57 passages run past 512 tokens and
   are cut.
6. **Vector.** The mean of the dequantised rows, summed left to right in float64, then L2-normalised. Closeness
   is the dot product. Ties go to passage order.
7. **Passage text**: the snapshot's title, statement (`text`) and rationale, joined by single spaces. Vol 1 comes
   first, then Vol 2, in snapshot order. `[V2 6109]`, listed twice in the Vol 2 snapshot, appears once.

Measured parity (`web/src/features/find/*.test.ts`):

- **Token IDs** equal Hugging Face tokenizers 0.23.3 on every fixture string: the 57 passages, 238 queries,
  150 typo variants, 95 Unicode cases and the gold questions.
- **Every code point**: the normaliser and pre-tokenizer reproduce the tokenizer on all 1,112,064 code points,
  checked by one SHA-256 under Node 25.4 (ICU 78.2, Unicode 17). NFD and lower-casing come from the browser's
  ICU, so a browser on another Unicode version can differ, but only on characters added since.
- **Vectors**: the TypeScript vectors equal the reference within 1e-9 per component. The top 5 is identical for
  every frozen query.

## Keyword column

Okapi BM25, k1 = 1.2, b = 0.75, idf = ln(1 + (N − df + 0.5) / (df + 0.5)). It uses Stabilis' `normalize()`:
NFKD, marks dropped, lower case, and anything outside a-z and 0-9 becomes a space. Words are not stemmed. The
stopword list is printed on the page.

## Gold questions

`web/src/features/find/gold.json` is a byte-for-byte copy of the file a separate agent wrote, blind to this tool,
before its first run. It was opened only after the token and vector parity above was frozen and committed, and it
is never edited.

- SHA-256 `319bc3c95e286cd66ebb85f39842b617ed6e1a1448cecc0a8451ad8c19fa44cd` (10,300 B)
- 24 questions, each with `origin: agent-written` and the IDs it was written for
- `written_by`: "an AI agent (Claude Code), blind to the search tool, before its first run"

A hit means that one of a question's expected requirements is first, or in the top three, of that column. "Either
column" counts a hit in the keyword column or in the meaning column. `find.test.ts` recomputes every number with
the shipped code and model files and compares it with `web/src/features/find/accuracy.json`, which the footnote
prints.

| column | first | in the top three |
| --- | ---: | ---: |
| Your words appear in (keywords, BM25) | 14 of 24 | 16 of 24 |
| Closest in meaning (potion-base-8M) | 15 of 24 | 20 of 24 |
| Either column | 19 of 24 | 22 of 24 |

The gate was the meaning column's top three on at least 70% of the questions, 17 of 24. It measured 20 of 24.
The questions were written by an agent, not by crew or clinicians, so these rates are likely optimistic.
