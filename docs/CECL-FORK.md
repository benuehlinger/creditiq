# credit-iq-cecl — fork charter

Written 2026-09-17, before the fork exists. This is the agreement on what the
fork is, why it waits, and what moves into it — so the decision survives the
sessions between now and then. Working names: `credit-iq` (this repo) and
`credit-iq-cecl` (the fork). Both are placeholders; renaming a repo and a
display string later is an afternoon, and GitHub redirects old URLs.

## The two products

|                    | credit-iq                          | credit-iq-cecl                     |
|--------------------|------------------------------------|------------------------------------|
| Buyer              | acquisition / underwriting desks   | banks that file reserves           |
| Question answered  | "what is this tape worth, today"   | "what is our allowance, this quarter" |
| Input              | someone else's tape, already a panel | own raw data, every quarter      |
| Speed              | hours matter                       | irrelevant                         |
| Shortcuts          | thinning allowed, always disclosed | none, anywhere                     |
| Output             | a loss view that informs a bid     | a reserve number and its document  |

## The dividing line, stated once

**credit-iq takes a panel and models it. credit-iq-cecl takes raw data and
builds a panel, with every decision documented.**

credit-iq's tape ingestion is a VALIDATION GATE, not a preparation engine: it
accepts a file that is already account-months, maps column names, asks the
four questions below, runs the integrity checks, and refuses clearly when the
file is not a panel. It never infers a default definition, never constructs a
panel from a snapshot, never derives realised LGD from raw recoveries. Those
require judgement, and judgement belongs where it gets documented.

The four questions credit-iq asks on upload (the things hardcoded per-book
today that stop being safe assumptions on foreign data):

1. Which column is the default flag, and at what delinquency state does the
   definition trip (`TargetDef.column`, `dpd_state`)?
2. Amortising loan or revolving commitment (`ead_method`)?
3. Where does the out-of-time window start (`oot_from`)?
4. What is this book called (`label`)?

## What the fork adds (CECL-only, the reason it exists)

- **Fundamental data preparation** — cleaning, outlier and missingness
  treatment, every decision recorded with a rationale, replayable.
- **Panel construction** — default definition, exit rules, observation
  window, servicer status-code dictionaries: as documented choices with an
  audit trail, never inference. Must surface EVERYTHING the model math needs:
  the default definition and every column required to compute realised LGD
  (recoveries, workout timeline, exposure at default) are first-class inputs,
  not derived guesses.
- **Segmentation** — defining cuts, fitting per segment, reconciling segment
  models to the total, defending the cuts. This changes what "a model" is
  (one spec becomes N plus a reconciliation) and is the single biggest reason
  a config flag is not enough.
- **Sampling** — formal design where used, and the documentation of it.
- **MDD generation** — the full Model Development Document rendered from the
  fitted results through an Rmarkdown template. Brings an R/knitr/LaTeX
  toolchain into the repo, which is dead weight for every credit-iq user and
  the second biggest reason to fork.
- **Rigour defaults** — no thinning anywhere: the variable screen, the
  search, everything runs on the full panel. Full fits for every enumerated
  model, not a top-N. Calibration (predicted vs actual rate) as a first-class
  board column, which full data enables without the intercept correction.
- Later: validation workflow (reviewer is not the developer), override
  tracking, effective-challenge records.

## What stays shared (do not let these drift)

Lineage, forking with rationale capture, the fork gate, the leaderboard and
provenance views, naming (each half named from its own hash, pairs collated),
the scenario/ECL engine, the roll-up. Both products need all of it. Until the
fork exists, anything in this list built or fixed here serves both.

## Why the fork WAITS (decision 2026-09-17)

1. Tape ingestion is being built here first, and the CECL app needs a
   superset of it. Build once, fork after.
2. Four known performance gaps are still open here (LGD-attach cache keying,
   roll-up reading stored ECL, saved-model cache pinning, dropping automatic
   finalists). Fixes benefit both products identically; fork after they land.
3. A fork taken mid-flux inherits bugs and then needs every fix twice.

Fork when: ingestion is merged, the four gaps are closed, and the first
CECL-only feature (likely the data-preparation module) is ready to start.

## Mechanics when the time comes

- Private repo (`credit-iq-cecl` or whatever the real name is by then),
  forked from a tagged commit of this repo, so the divergence point is named.
- Port demo-repo fixes into the fork early and deliberately; stop syncing
  once the cores diverge (data-prep and segmentation will diverge them fast).
- The rigour defaults flip in config, not by deleting the fast paths —
  keeping the code paths identical for as long as possible makes porting
  fixes across the pair cheap.
- Rename both products together when the branding lands (candidates on file:
  Helios family — Hyperion, Colossus, Selene, Heliograph, Aphelion).
