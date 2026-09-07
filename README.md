# lumen-locales

Open-source translation files for [Lumen](https://github.com/Lumen-media/lumen). This repo is the **source of truth** for Lumen translations: editing a string or adding a language happens here via PR — Lumen downloads the files at runtime, so a translation change never requires an app release.

## Layout

```
locales/
  en.json        canonical — keys are the English strings
  pt-BR.json     every locale must contain all keys from en.json
languages.json   index of available languages (code, name, nativeName)
scripts/
  validate.mjs   CI validation (plain node, no deps)
```

## Contributing a translation

1. Edit `locales/<lang>.json` (remove lines — never remove keys — and translate the values), or add a new `<lang>.json`.
2. New languages: also add an entry to `languages.json` (`code` matches the file name).
3. Open a PR. CI checks JSON validity, size (≤ 1 MB/file), and key-parity: every locale must contain **all** keys from `en.json`. `en.json` keys are never removed — breaking the parity is a hard failure.

## Releases

On merge to `main`, the `release` workflow validates again and creates an immutable tag `v<date>.<n>` — a per-day counter (`v2026.09.07.1`, `.2`, …), no hashtags. Every release is unique, so jsDelivr never serves stale content:

```
https://cdn.jsdelivr.net/gh/Lumen-media/lumen-locales@<tag>/locales/pt-BR.json
```

## Consuming

Lumen checks the latest tag at startup (background, silent on failure), downloads changed files from jsDelivr, validates them again locally, and caches in `{app_data_dir}/locales/`. If validation fails or the network is unavailable, the app keeps the last-good cache and falls back to the bundled strings bundled in the app binary.

## Local checks

```sh
node scripts/validate.mjs
```