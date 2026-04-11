# Oink Soccer

This repository contains the Oink Soccer calculator app and the automation around keeping its game data in sync with the upstream common data source.

## Repository Layout

- `oink-soccer-calculator/`: the Vite + React application that is deployed to GitHub Pages.
- `.github/workflows/`: CI workflows for deploys, previews, and upstream data sync.
- `package.json`: minimal root-level dependencies used by repository tooling.

## Calculator App

The calculator app lives in [`oink-soccer-calculator/`](./oink-soccer-calculator) and includes:

- wallet connection support for supported Algorand wallets
- playable catalog loading for the current Oink Soccer season
- opponent team import helpers
- local simulation and boost calculations

App-specific commands:

```bash
cd oink-soccer-calculator
npm install
npm run dev
npm test
npm run build
```

See [`oink-soccer-calculator/README.md`](./oink-soccer-calculator/README.md) for app-level details.

## Upstream Sync

Season allocation data and rules are sourced from [`stein-f/oink-soccer-common`](https://github.com/stein-f/oink-soccer-common).

The sync pipeline:

1. clones or refreshes the upstream repo
2. regenerates the playable catalog for the upstream `current_season`
3. refreshes the local game-rules snapshot
4. verifies the generated rules still match expected parity checks

Run it locally with:

```bash
cd oink-soccer-calculator
npm run sync:upstream
```

To verify whether committed artifacts are behind upstream:

```bash
cd oink-soccer-calculator
npm run check:upstream
```

The scheduled GitHub Actions workflow in [`.github/workflows/upstream-sync.yml`](./.github/workflows/upstream-sync.yml) opens a PR whenever the generated artifacts change.

## Deployment

The production app is published with GitHub Pages:

- Production: [twirtle2.github.io/Oink-Soccer-Calculator](https://twirtle2.github.io/Oink-Soccer-Calculator/)
- PR previews: `https://twirtle2.github.io/Oink-Soccer-Calculator/pr-preview/pr-<PR_NUMBER>/`
