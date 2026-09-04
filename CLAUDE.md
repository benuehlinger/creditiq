# CreditIQ — orientation for AI agents

Credit risk model development demo (PD + LGD on synthetic panels, Federal
Reserve scenario projection, ECL). React/Vite frontend, FastAPI backend.

## Run it

```
make setup     # once: venv + deps (fast with warm caches)
make dev       # backend :8000 (--reload), frontend :5173
```

First boot on a machine with no data shows a "Generate the synthetic data"
button (~20s–3min depending on hardware). `make data` does the same from
the CLI. `make demo` pre-warms caches (~9 GB RAM). `make test` runs the
backend suite (~5 min); `cd frontend && npx vitest run` the frontend's.

## Contracts — do not violate these

1. **Pristine clone.** Nothing generated and nothing user-made is ever
   committed: all of `data/synthetic/`, `docs/GENERATIVE_TRUTH.md`, and
   `versions/` are gitignored. Never force-add them.
2. **No silent fallbacks.** A missing prerequisite shows an empty state
   naming what is missing plus the one action that fixes it. Never
   substitute a default specification or ghost value anywhere.
3. **Stress transmission: macro terms only.** The scenario reaches a model
   exclusively through the MEV terms in its specification. Internal
   variables are frozen at the reporting date in projections.
4. **One copy of every fact.** Specifications live in the Zustand store;
   results live only in identity-keyed caches (query cache → backend
   memory → fingerprinted disk at `data/cache/`). Never hold a spec or a
   result in component `useState`. Fitting happens on explicit user action
   only; switching tabs/models/pages must cost zero computation.
5. **All statistics genuinely computed**; synthetic data always labelled;
   no claimed regulatory approval; no em dashes in UI prose; plain
   statistics vocabulary ("test data", never "slice").

## Where things are

- `backend/creditiq/models/` — fit, ECL, scenarios, versioning, caches
- `backend/creditiq/data/` — seeded generator (deterministic per machine)
- `frontend/src/lib/progress.ts` — THE state machine (spec→fit→projection→save)
- `frontend/src/lib/store.ts` — persisted UI store (version-gated)
- `docs/STATE.md` — the state/caching contract in full
- `docs/DECISIONS.md` — every non-obvious choice with its reasoning.
  **Read the relevant entry before changing behavior** — most surprising
  code is deliberate and documented there.
- `docs/HANDOFF.md` — new-machine setup and troubleshooting

## Invalidation (already handled — don't rebuild it)

The store stamps `build_report.json`'s mtime and clears every registered
derived cache on change; the frontend polls a data fingerprint and reloads
on change; disk-cache keys carry the fingerprint. If data seems stale:
`make reset` (clears versions, `data/cache/`, regenerates panels).
