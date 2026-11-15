# potion-base-8M, 8-bit copy

Source: [minishlab/potion-base-8M](https://huggingface.co/minishlab/potion-base-8M), revision `bf8b056651a2c21b8d2565580b8569da283cab23`, MIT licence (model card
metadata `license: mit`; see LICENSE.txt). Base model BAAI/bge-base-en-v1.5 (MIT). Training set
minishlab/tokenlearn-c4-en-bge-base-v1.5: its licence was not verified.

Source files (checked before reading):

| file | bytes | SHA-256 |
| --- | ---: | --- |
| `model.safetensors` | 30,236,760 | `f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2` |
| `tokenizer.json` | 683,666 | `e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50` |

Outputs:

| file | bytes | SHA-256 |
| --- | ---: | --- |
| `embeddings.i8` | 7,559,168 | `e79c31afbaf7b4a876449aa10856e6621d9ffea7cd4d5ce6e64dd6f6ca4a4b29` |
| `scales.f32` | 118,112 | `9a42e12a15278a8fcf9b41745fb7747b929725e01b5f401f5517713b7369666f` |
| `vocab.txt` | 219,690 | `1394523a67ddd404a825428018c0582a6998bcfa044ecbcbf1f4d71adb94c61c` |

Per row: scale = max|row| / 127 (stored as float32); q = floor(x / scale + 0.5), clipped to -127..127.
The browser reads q * scale. `vocab.txt` holds the tokenizer's WordPiece tokens in ID order, one per line.

Command (standard library only):

    python -I tools/find/quantize.py <model_dir> web/public/assets/models/potion-base-8M-bf8b0566
