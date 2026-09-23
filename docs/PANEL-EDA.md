# The Panel dashboard: what a buyer wants to know in five minutes

Design note, 2026-09-19. Two questions that turn out to be one question:
how does the app know a vintage is a cohort and not a measurement, and
what exploratory views belong on the Panel surface?

## The unifying fact: every loan-month has three time coordinates

- **Months on book (AGE)** — how seasoned the loan is
- **Performance date (PERIOD)** — the calendar month, and so the macro environment
- **Vintage (COHORT)** — when it was originated

and `vintage + months_on_book = performance_date`. Any two determine the
third. This is the age-period-cohort identification problem, and it is the
reason these are three different charts rather than one chart with a
dropdown: each holds one coordinate fixed to see another.

| Axis | The question it answers |
|---|---|
| Performance date | What is the environment doing to my book right now? |
| Months on book | When do losses emerge for this product? |
| Vintage | Is underwriting getting better or worse? |

**This also answers the vintage-versus-continuous question.** A vintage is a
cohort IDENTITY, not a quantity: 2021 is not "two more" than 2019 in any
sense a coefficient can use, and at scoring time future vintages do not
exist to extrapolate to. That is why it must never enter a model as a linear
term — and equally why it earns its own axis here. Same fact, two
consequences.

## How the app currently decides, and why that is not enough

`analysis/screening.is_cohort_label()` — a heuristic. A column is a cohort
if its name contains "vintage"/"cohort", or its values are whole calendar
years in 1970-2049. It routes such columns to the categorical path in both
the PD screen and the LGD candidate list.

That stops the bug that prompted it (20 vintage years cleared the ">12
unique values means continuous" rule and were offered as a linear term).
It will still be wrong sometimes:

- `202103` style YYYYMM cohorts — not detected
- `vehicleModelYear` — detected, which is arguably right but was not decided
- a genuinely continuous column that happens to hold year-like values

The resolution is the one in TAPE-FLEXIBILITY.md: **the heuristic PROPOSES,
the user CONFIRMS, and the declaration persists on the book record.**
Invisible logic that is right 90% of the time is worse than visible logic
that is right 90% of the time and says so. Column-role declaration is
therefore the piece that "lands" the mapping process — mapping answers what
a column IS, declaration answers how it should be READ.

Derivation note: ingested tapes carry `months_on_book` and
`origination_date` but NO `vintage` column; the synthetic books carry all
three. Vintage must be derived from the origination date (the year, or a
coarser bucket where years are thin) in one shared place, not per chart.

## The views, and the question each one answers

Curated deliberately. The discipline: **every chart earns its place by
answering a question a buyer asks in the first five minutes.**

1. **Vintage loss curves** — cumulative default rate by months on book, one
   line per vintage. The fundamental credit chart: it separates underwriting
   quality from the environment. Already computed (`backtest.vintage_curves`),
   never surfaced outside the PD fit results. Must handle unequal maturity
   honestly: a 2025 vintage has twelve months of history and its cumulative
   rate is not comparable to a 2021 vintage's. Truncate to a common maximum
   months on book, or fade the thin tail, but never draw them as equals.

2. **Seasoning hazard** — marginal default rate by months on book, vintages
   pooled. Where does risk peak, and is this pool past it? A seasoned pool
   past its peak is worth more than a green one, and this is the chart that
   shows it.

3. **Composition through time** — stacked share by a chosen categorical on
   the performance-date axis. Mix shift: is the book drifting toward a
   riskier segment? `/timeseries?by=` already returns exactly this data.

4. **Rate by segment through time** — the same data as lines rather than
   stacks: default rate per level. Stacks answer "how much of what", lines
   answer "which is worse".

5. **Distribution drift by vintage** — for a numeric driver (score, LTV,
   DTI, term), percentile bands per vintage. The underwriting-drift chart,
   and the one that most often explains a vintage curve that moved.

6. **Exposure runoff** — balance and open-account count through time. Is
   this book amortising, revolving, or growing?

### Further candidates, in value order

- **Roll rates / transition matrix** — where a delinquency state exists:
  Current to 30 to 60 to 90, monthly. The operational credit chart for a
  servicer tape, and the earliest warning of deterioration.
- **Coverage heatmap** — account-months per vintage x months-on-book cell.
  Instantly shows where the tape is thin, which is precisely where a vintage
  curve stops being trustworthy. Also exposes the right-triangle shape every
  real panel has.
- **Runoff by terminal reason** — share of accounts still active by months
  on book, split into default, prepaid, matured. Prepayment competes with
  default, and anyone pricing a tape needs both.
- **Concentration** — largest exposures as a share of the book. One number,
  disproportionate value to a buyer.

## Core columns versus the rest: the split already exists

The canonical schema carries a `role` on every field, and that is exactly
the split the dashboard's controls should follow:

| Group | Fields | Use in the dashboard |
|---|---|---|
| Structural | account_id, performance_date | Define the grid. Never plotted; they ARE the axes. |
| Target | default_flag | What every rate is measured on. |
| Time / cohort | origination_date, months_on_book, derived vintage | The three axes. |
| Exposure | current_balance, scheduled_payment, interest_rate, remaining_term | Money-weighted measures. |
| Severity | lgd_realised, recovery_amount, exposure_at_default, workout_months | Severity views, when present. |
| Drivers | everything that rode along | What you slice BY. |

So most of the views above collapse into ONE chart with three small
controls, each populated from a role group:

- **Axis** from the time group — performance date, months on book, vintage
- **Measure** from target + exposure — default rate, account count, balance
- **Slice** from drivers — categorical levels stack or line; numeric
  auto-banded into quantiles

Two charts keep fixed shapes because their meaning is fixed: the vintage
loss curves and the seasoning hazard.

This is also why the dashboard should NOT simply plot every column. A
column's role decides which control it appears in; a column with no role
worth plotting appears in none.

## Build order

1. Derive vintage in one shared place, and expose an EDA endpoint serving
   (axis, measure, slice) aggregates plus the two fixed charts.
2. The three-control chart on the Panel surface, with the role-driven
   control population above.
3. Vintage loss curves and seasoning hazard, with honest maturity handling.
4. Column-role declaration — the heuristic's proposal made visible and
   overridable, persisted on the book record. This is what lands the mapping
   process, and it is what makes 1-3 correct on a foreign tape rather than
   correct-by-luck.
