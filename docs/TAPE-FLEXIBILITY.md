# Handling arbitrary tapes without becoming the CECL app

Design note, 2026-09-19. Prompted by the question: once real tapes arrive,
how flexible must ingestion be — column mapping, type detection, high
cardinality, missingness, outliers, stratification — before quick analytics
turns into a data-preparation product?

## The principle

**CreditIQ lets you change how the model READS the tape, never what the tape
says.** The tape is immutable evidence.

- A *read declaration* — treat this column as categorical, bin it this way,
  exclude it, stratify the roll-up by it — lives in the specification or the
  book's record. It is therefore hashed, named, versioned, and forkable with
  a rationale. The lineage system gives every data decision the same audit
  trail as every model decision, at no extra cost.
- A *data edit* — impute a missing value, winsorize an outlier, recode a
  level, derive a column, restructure the panel — changes the evidence. The
  identity story (tape fingerprint + spec hash reproduces the model) breaks
  unless every mutation is itself versioned and documented, which is the
  CECL app's data-preparation module by definition (see CECL-FORK.md).

The quality bar follows from the same principle: the gate refuses what makes
a panel structurally unusable; everything softer becomes a visible finding
with a default read-policy the user can override, never a silent repair.

## What already exists (verified in code, 2026-09-19)

| Concern | Where it is handled | Mechanism |
|---|---|---|
| Unknown column names | `tapes.suggest_mapping` | Case/separator-insensitive matching + curated alias vocabulary (incl. Reg AB II). Only 3 columns are required; the rest ride along as candidates. |
| Type/role detection | `analysis/profile.py` | dtype, role (identifier/date/target/driver/outcome), unit, cardinality, missingness, constants, outlier counts. |
| Static vs time-varying | `tapes._spec_from_record` | Constant-per-account columns split to the accounts table and become drivers automatically. |
| High-cardinality categoricals | `analysis/binning.bin_categorical` | Population-floor collapse into an Other bin, shrinkage toward the book average, permutation null floor. Tested against 144 metros (`test_high_cardinality.py`). |
| High-cardinality numerics | treatments | Continuous, spline, or binned — all absorb cardinality; binning is outlier-robust by construction. |
| Missing values | `analysis/binning.py`, `models/design.py` | Missing gets its OWN bin with its own weight of evidence (`MISSING_LABEL`, `missing_woe`). A read-policy, not an imputation. |
| Structural quality | `tapes.ingest` + `profile.check_integrity` | Refuses duplicates, non-0/1 flags, unparseable dates, missing required columns — by name. Judgement findings land on the Panel surface scorecard. |
| Leakage / weak signal | variable screen | Columns arrive EXCLUDED by default with the reason shown; inclusion is deliberate. |
| Browsing the data | `/api/portfolios/{key}/sample` + column profile | Read-only. |

## The gaps (build in CreditIQ — all read declarations)

1. **User-chosen stratification.** `rollup._bands()` hardcodes the
   stratifier per synthetic book; an ingested book collapses to one "all"
   band, so concentration and by-segment views say nothing. Fix: the app
   PROPOSES a stratifier (best low-cardinality categorical by signal, or a
   binned numeric such as credit score), the user confirms or overrides, and
   the choice is stored on the book record. Visible proposal, never a silent
   default — house rule.

2. **A column-declarations panel, not a data editor.** One place (Panel
   surface, or step two of ingestion) showing every column with its INFERRED
   type, role, cardinality, and missingness, plus an override per column
   (numeric / categorical / date / identifier / ignore). Overrides persist
   into the tape record and flow into screening and treatments. This is the
   flexibility a foreign tape actually needs; it costs the user seconds.

3. **Quality findings become default policy.** A column above a missingness
   threshold, a constant column, an identifier-shaped column: excluded by
   default with the reason printed, includable deliberately. Extends the
   exact pattern the leakage screen already uses. No thresholds hidden; the
   scorecard names each one.

4. **Content-based mapping suggestions.** Today's mapping is name-only (a
   curated vocabulary). Add inference from the data itself: a 0/1 column is
   a flag candidate, a column unique per account-month is the key, a column
   that parses as monthly dates is the period, a [0,1] column on defaulted
   rows is a severity candidate. Ranked suggestions, still confirmed by the
   user in the same mapping table. This is what makes ingestion robust for a
   seller whose vocabulary nobody listed.

## Severity without workout data (finding, 2026-09-19)

ABS-EE recovery fields are OPTIONAL in practice: Santander Drive files
`chargedoffPrincipalAmount` and `recoveredAmount` (populated); Carvana and
others file neither. Most real tapes will have defaults but no workout data,
and today such a book dead-ends — no `lgd_realised`, no severity model, no
saved version, no ECL, never on the roll-up.

Resolution, in two halves:

- **Where recovery fields exist**, the PREP script derives severity (EAD =
  charged-off principal; recoveries accumulated from post-charge-off rows;
  LGD = (EAD − recoveries)/EAD; workout months from the recovery trail),
  restricted to defaults with a seasoned workout window so unfinished
  workouts do not overstate severity. Panel construction — never in the app.
- **Where they do not**, the app offers a DECLARED severity assumption as a
  first-class alternative to a fitted LGD model. Explicit empty state on the
  LGD stage naming the missing columns; one action: enter an assumed
  severity (sourced from deal docs / rating-agency recovery assumptions).
  The assumption is part of the specification — hashed, versioned, forkable
  — the pairing displays `<pd-name> · assumed 55%`, and the roll-up row
  carries an "assumed severity" pill. A labelled declaration, never a
  hidden default.

## What CreditIQ refuses (route to the CECL app)

- Imputation of missing values (beyond the missing-bin read-policy)
- Winsorizing, trimming, or deleting outlier rows
- Recoding values or levels ("Y"/"N" → 1/0 included — refused today, stays refused)
- Deriving new columns from existing ones
- Panel construction from snapshots or raw performance files
- Segmentation schemes as data transformations

Each of these is a judgement that changes the evidence. The CECL app's
data-preparation module makes them first-class, documented, reproducible
steps; CreditIQ pretending to do them quickly would do them silently.

**Explicitly rejected: an editable data grid.** Browsing is cheap and honest
and already exists. Editing is an unbounded product surface and an untracked
mutation channel — the precise mechanism by which the fast tool would grow
into a bad version of the rigorous one.

## Order of work

1. Stratifier selection (visible payoff immediately on the roll-up with the
   four real auto tapes: Toyota / Hyundai / Santander / Carvana).
2. Column-declarations panel (merge the profiler's inference with per-column
   overrides; persist on the tape record).
3. Quality-to-policy wiring (missingness/cardinality/constant exclusions by
   default, with reasons).
4. Content-based mapping suggestions.

All four are shared surface: they land before the fork and benefit both
products, consistent with the fork-timing decision in CECL-FORK.md.
