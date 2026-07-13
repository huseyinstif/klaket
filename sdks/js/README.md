# klaket

Typed JS/TS client for [Klaket](https://github.com/huseyinstif/klaket) — turn any video into LLM-ready data: word-timestamped transcripts, speaker labels, scenes, keyframes, on-screen text, chapters and subtitles.

```bash
npm i klaket-sdk
```

```ts
import { Klaket } from "klaket-sdk";

const k = new Klaket();                       // self-hosted on localhost:8484
const result = await k.process("https://youtube.com/watch?v=...");
for (const seg of result.transcript) {
  console.log(seg.start, seg.speaker ?? "", seg.text);
}

// or step by step
const id = await k.ingest("https://...", { model: "medium", numSpeakers: 2 });
await k.wait(id);
const hits = await k.search(id, "docker compose");
```

Zero dependencies. Works against any self-hosted Klaket (`docker compose up` in the [main repo](https://github.com/huseyinstif/klaket)) — no API key required. Pass `apiKey` for cloud deployments.

MIT licensed.
