# State: identities, caches, and when computation is allowed

The application's one hard rule: **a result is a pure function of an
identity, and identities are hashes of specifications (given the data's
fingerprint)**. Everything below is the enforcement of that rule.

## Identities

| Thing | Identity | Where it comes from |
|---|---|---|
| PD half | `pd_hash` — hash of the PD specification alone | fit response `pd_hash`, version `metrics.pd_hash` |
| LGD half | hash of the LGD specification | LGD fit response `hash` |
| Model | pair hash — PD spec with the LGD spec embedded | fit response `hash`, `/api/model/identity`, version `hash` |
| Data | fingerprint — digest of the build report incl. content | `/api/health.data_fingerprint` |

An edited, unfitted draft has **no identity** (LGD hash `''`, PD marked
stale). It earns one by being fitted.

## Where state lives — and the one-copy rule

- **Specifications** live in the Zustand store (`pdSpec`, `fittedLgd.spec`),
  one per book. No component keeps a copy; panes receive the store's object.
  (Both historical violations — the PD pane's hydration clone and the LGD
  pane's local spec — produced the "list says 5, fit says 0" class of bug
  and are deleted.)
- **Results** live in caches keyed by identity, three layers deep: the
  TanStack query cache (`['model', hash]`, `['lgdfit', p, hash]`,
  `['ecl', p, pdHash, lgdHash, capped]`, `['rollup', selection]`, plus the
  derived views — recohort, segment, sensitivity, backtest — each keyed
  hash + parameters); the backend memory caches; and the fingerprint-keyed
  disk cache (`data/cache/`). Results never live in `useState`.
- **View state** (open tab, hover, chart width, backtest frequency) lives in
  `useState` and is the only thing allowed to.
- **Persisted browser state** is the store's working set (specs, fitted
  identities and headline metrics, drafts, loaded markers) plus
  preferences. A store version bump clears the working set everywhere.

## When computation is allowed

Exactly three triggers, all user-visible:

1. **An explicit fit/re-project click** (including the model bar's call to
   action, which is the same click routed through the `cta` store flag).
2. **Opening a saved version** replays it — "open" means "show me this
   model", and with the disk cache warm the replay is a lookup, not a
   computation. Guarded to once per opened version per session
   (module-scoped, because a component ref dies with the unmount a tab
   switch is), and it waits for the cache lookup before estimating.
3. **Arriving at Scenarios or the Roll-up with complete, reported models**
   projects them — the projection is the page's content. Identity-keyed,
   so it computes once per identity and is a cache read forever after.

Everything else — switching tabs, switching models, reloading the page,
restarting the server — is lookups. Two full PD↔LGD round trips measure
zero API calls; a fresh session serves all first-paint data inside ~200ms
from the disk layer; switching challengers on any page re-fits nothing.

## When the user is prompted

- **Editing while a saved model is open** → the fork dialog. A saved model
  never changes; the edit becomes a new draft with the original as parent.
- **Saving** → "Update <name>" (supersede) or "Save as a new version",
  explicit, side by side.
- **A missing prerequisite** → a full empty state naming what is missing
  and carrying the one action that fixes it. Nothing is substituted:
  no default LGD in scenarios, no documented default in the roll-up, no
  auto-fitted proposal on a virgin book. Defaults appear only as visible
  pre-selected proposals awaiting the click that makes them a decision.
- **Drift** (a saved model whose replay no longer reproduces its recorded
  hash — the data or engine changed under it) → "Save as a new version",
  never "Refit and compare": the divergent refit already happened.

## Invalidation

One authority: the store stats the build report's mtime on every read and,
on a change, drops its frames and every registered derived cache in one
move. The frontend polls the combined fingerprint (background tabs
included) and reloads on a change. Disk-cache keys carry the fingerprint,
so a rebuilt panel makes old entries unfindable rather than stale. The
tradeoff is stated where it lives: cache keys carry the data's identity,
not the code's, so editing an analytic requires `make reset`.
