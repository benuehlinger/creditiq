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
backend suite (~5 min); `cd frontend && npx vitest run` the frontend's;
`make e2e` (with `make dev` running) executes the browser contract suite
that fails if navigation ever triggers computation.

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
- `backend/creditiq/models/selection.py` — the automated variable search
  (stepwise cores + 1-3 MEV enumeration); results cached under kind
  "selection", review state in `versions/selection/`
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

## Working with the developer

The developer cannot see background jobs, tool output, or intermediate
reasoning. Only what is written in the reply exists for them. Everything
below follows from that.

### Stop and ask before changing a number

Any change to what the numbers MEAN is the developer's decision, not the
assistant's. Propose it, show the effect, wait for an answer:

- the target definition (what counts as a default, and in which month)
- which rows are kept or dropped (filters, samples, exclusions)
- a derived column's formula
- a threshold that gates a warning or a refusal
- anything that changes a count, a rate, or a loss figure

Show the effect as a before/after table with the actual numbers, not a
description of them:

| | before | after |
|---|---|---|
| defaults | 188,948 | 137,510 |
| accounts | 998,452 | 998,435 |

A 27% move in the default count is a modelling decision. It was made three
times in one session without being put to the developer once, and twice it
was wrong. Implementation details — a loop, a parse, a cache key — do not
need this. If it moves a number on screen, it does.

### Say what is running, and what it will produce

Before a background job, state in one line: what it does, how long, what
file or result appears at the end. While it runs, do not start a second
investigation — the developer is waiting on the first and cannot see either.

### Explain with the data, not with vocabulary

Findings are quantitative. Show the rows, the counts, the distribution:

| on code-4 rows (10,638) | |
|---|---|
| `recoveredAmount > 0` | 0 |
| end balance = 0 | 10,638 |
| median delinquency | 463 days |

Then say what it means in plain words. The developer is an expert credit
analyst and a novice coder: statistical substance lands, software jargon
does not. Never write a sentence whose purpose is to sound authoritative.
If a term is unavoidable, define it once in the same breath.

### Do not widen the blast radius

While fixing one thing, do not edit shared code for a different thing.
Numerical code (`analysis/`, `models/fit.py`, `models/design.py`,
`analysis/spline.py`) is used by every book: a change there is its own
task, with its own before/after evidence, never a side quest inside
another investigation.

### Never touch the developer's working state

`make reset`, `POST /api/workspace/reset`, deleting a book, clearing
`data/cache/` — these destroy work the developer built by hand. Do not run
them to clear a cache or tidy up. Ask. (One reset in this session archived
an ingested book the developer had just loaded.)

Do not ingest, delete, or archive tapes while the backend test suite is
running; the suite reads panels lazily and a mid-run change produces dozens
of phantom failures.

### When it goes wrong, say so first

Lead with the failure and its size, before the fix. "The build worked but
the combine crashed and the six-minute download was discarded" comes before
the explanation of why. Corrections to the assistant's own earlier claims
are stated plainly as corrections, not folded quietly into new text.
