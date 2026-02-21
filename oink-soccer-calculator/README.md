# Oink Soccer Calculator

Static, wallet-aware Oink Soccer calculator hosted on GitHub Pages.

## Features

- Connect Pera, Defly, and Kibisis wallets via `@txnlab/use-wallet-react`.
- Sync playable assets from connected MainNet wallets.
- Import opponent lineup from Lost Pigs opponent team URL.
- Run formation/boost simulation with local persistent state (`oink-soccer-calc:v2`).
- Display active season dynamically from catalog metadata.

## Local Development

```bash
npm install
npm run dev
```

## Build and Lint

```bash
npm run lint
npm run build
```

## Catalog + Upstream Sync

Current playable catalog is served from:

- `public/data/playable-catalog-manifest.json`
- `public/data/playable-assets.s<season>.json`

Generate catalog directly from a local upstream clone:

```bash
npm run generate:catalog -- /path/to/oink-soccer-common
```

Generate upstream game-rules snapshot:

```bash
npm run generate:rules-snapshot -- /path/to/oink-soccer-common
```

Full upstream sync (catalog + snapshot + parity check):

```bash
npm run sync:upstream
```

Blocking upstream drift check (used in CI):

```bash
npm run check:upstream
```

Notes:

- If no path is provided, sync scripts default to `/tmp/oink-soccer-common`.
- `check:upstream` will fail when generated artifacts differ from committed files.

## CI / Automation

- `.github/workflows/deploy-pages.yml`: builds and deploys production site to `gh-pages` on push to `main`.
- `.github/workflows/deploy-pages-preview.yml`: builds and deploys PR previews to `gh-pages/pr-preview/pr-<number>/`.
- `.github/workflows/cleanup-pages-preview.yml`: removes PR preview path after PR close.
- `.github/workflows/upstream-sync.yml`: weekly upstream sync that opens a PR when data/rules change.
- `.github/workflows/upstream-drift-check.yml`: runs on push/PR and fails on upstream drift.

## GitHub Pages

- App URL: `https://twirtle2.github.io/Oink-Soccer-Calculator/`
- PR preview URL pattern: `https://twirtle2.github.io/Oink-Soccer-Calculator/pr-preview/pr-<PR_NUMBER>/`
- PR previews deploy only for pull requests opened from branches in this repository (fork PRs are skipped).
- Vite base path is configurable via `VITE_BASE_PATH` (default: `/Oink-Soccer-Calculator/`).
