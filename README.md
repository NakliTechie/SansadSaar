# SansadLocal

> Browse, search, and summarise Indian Parliamentary Committee reports — privately, on-device.

**[Live demo →](https://naklitechie.github.io/SansadLocal/)** · No accounts. No keys required. No data leaves your device.

A single HTML file. All 24 Departmentally Related Standing Committees (DRSCs) — 16 chaired by Lok Sabha, 8 by Rajya Sabha. Reports scraped daily from [sansad.in](https://sansad.in), mirrored as static JSON on GitHub Pages, summarised in your browser by Gemma over WebGPU (or by your own API key, if you prefer a remote model).

## Why

Committee reports are how the Indian Parliament actually scrutinises the executive. Demands for grants, bills, action-taken reports, policy subjects — non-partisan, evidence-based, and barely read. Existing portals make them hard to discover, harder to skim, and impossible to ask questions of. SansadLocal fixes the discovery layer; the AI fixes the skim layer; both happen on your machine.

## How

| Layer        | Where it lives                                                                 |
| ------------ | ------------------------------------------------------------------------------ |
| Data scrape  | [`naklitechie/parliamentwatch-data`](https://github.com/NakliTechie/parliamentwatch-data) — daily GH Action runs upstream's [Python scraper](https://github.com/pranaykotas/parliamentwatch) and commits the output. |
| Data hosting | GitHub Pages serves `reports.json` + `text/*.txt` with proper CORS.            |
| App          | This repo — one `index.html`, no build step, GitHub Pages.                     |
| AI inference | [Transformers.js v4](https://huggingface.co/docs/transformers.js) running Gemma 4 E2B on WebGPU, or any OpenAI-compatible / Anthropic API you BYOK. |

## Local dev

Open `index.html` directly, or:

```bash
python3 -m http.server 8000
```

Pass `?data=URL` to point at a different mirror (e.g. for local testing against `parliamentwatch-data/docs/`).

## Credit

Built on top of [ParliamentWatch](https://github.com/pranaykotas/parliamentwatch) by Pranay Kotasthane — the scraping logic, committee config, and the original idea are his. SansadLocal repackages it as a single file with on-device AI.

## Privacy

Your API key (if you set one) lives in `localStorage` and is sent only to the provider you chose. Generated summaries cache to `IndexedDB`. Model weights cache to browser Cache Storage on first load. No analytics, no accounts, no telemetry, no server (we don't have one).

## License

MIT — see [LICENSE](LICENSE).

---

Part of the [NakliTechie](https://naklitechie.github.io/) browser-native series.
