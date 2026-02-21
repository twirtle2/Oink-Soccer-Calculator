# Oink Soccer Calculator

Wallet-aware simulator for Oink Soccer lineups.  
The app now runs fully on static hosting (GitHub Pages), persists data in browser local storage, and can sync playable assets from connected Algorand wallets.

## Features

- Connect wallets with `@txnlab/use-wallet-react` (Pera, Defly, Kibisis).
- Sync playable assets for connected accounts from Algorand MainNet holdings.
- Keep full simulator workflow (manual edits, screenshot import, opponent team simulation).
- Persist squads/forms/settings locally via `oink-soccer-calc:v2`.
- Deploy on GitHub Pages via GitHub Actions.

## Local Development

```bash
npm install
npm run dev
```

## Environment Variables

Screenshot scanner requires Gemini API key:

```bash
VITE_GEMINI_API_KEY=your_key_here
```

Without this env var, screenshot upload is disabled with an error message, but wallet/manual simulation still works.

## Playable Asset Catalog

Catalog is generated from [`oink-soccer-common`](https://github.com/stein-f/oink-soccer-common) and stored as:

- `public/data/playable-assets.s14.json`

Regenerate:

```bash
npm run generate:catalog -- /path/to/oink-soccer-common
```

If no path is provided, the script will try common defaults (including `/tmp/oink-soccer-common`).

## Build and Lint

```bash
npm run lint
npm run build
```

## GitHub Pages Deployment

Deployment is automated by:

- `.github/workflows/deploy-pages.yml`

On push to `main`, workflow builds from `oink-soccer-calculator/` and deploys `dist/` to GitHub Pages.

Vite base path is set to:

- `/Oink-Soccer-Calculator/`
