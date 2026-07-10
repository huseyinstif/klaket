# klaket (Python SDK)

Turn any video into LLM-ready data. Zero dependencies.

```bash
pip install klaket
```

```python
from klaket import Klaket

k = Klaket()  # self-hosted; Klaket("https://api.klaket.dev", api_key="klk_...") for cloud

result = k.process(
    "https://youtube.com/watch?v=...",
    model="medium",                 # optional quality bump
    prompt="Klaket, Docker, RAG",   # proper-noun hints
    num_speakers=2,                 # diarization hint
)

for seg in result["transcript"]:
    print(f'[{seg["start"]:7.2f}] {seg.get("speaker", "")}: {seg["text"]}')

hits = k.search(result["id"], "docker compose command")
```

MIT licensed. Part of [Klaket](https://github.com/klaket/klaket).
