# LANDFALL web app

The judged app: Vite + React + TypeScript, served as static files with no backend. The TypeScript engine in
`src/engine/` is a port of the Python reference engine (`../engine/`), held to it by the shared conformance vectors;
the rules are the same `../engine/rules/*.json` files, bundled at build. The frozen NASA, NOAA and scenario snapshots
are in `public/data/`. A service worker (`public/sw.js`, production builds only) keeps the app working offline after
the first load.

```bash
npm ci
npm run dev                                # development server
npx vitest run                             # engine conformance, scenario and feature tests
npx tsc -p tsconfig.app.json --noEmit      # type check
npx vite build                             # production build in dist/
```

- `src/engine/README.md`: the engine port, its proof and the Python-to-TypeScript name mapping.
- `src/app/README.md`: the shell (routes, mission model, store, UI primitives, colour tokens) that the feature views
  in `src/features/` build on.
- `../engine/SPEC.md`: the contract both engines follow.
