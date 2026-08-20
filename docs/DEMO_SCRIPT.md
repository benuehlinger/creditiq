# Demo script — 12 minutes

**Before you start:** run `make reset`, then open `http://localhost:5173/rollup`
and leave it there. The backend warms its caches at boot, so give it about thirty
seconds before the first click.

Every screen is one keystroke away: `⌘K` opens the command palette, `0` jumps to
the roll-up, `1`–`5` move between surfaces within a portfolio. Use them if a
click goes astray.

---

## 0:00 — Open on the number (45 seconds)

**Screen:** Portfolio Roll-Up.

> "This is the whole book — three portfolios, twenty-six billion of exposure.
> Under the Fed's 2026 severely adverse scenario, expected credit loss is 2.3
> billion. That's 7.4 times baseline, and 915 basis points.
>
> Everything behind this number was built this morning. Let me show you how, and
> then we'll come back here."

Point at the amber badge on the CRE card — *2 variables out of range*. Say you'll
come back to it. It matters and it is the most defensible thing on the screen.

---

## 0:45 — The data (90 seconds)

**Click:** Residential mortgage → Data.

> "One-point-seven million account-months. Before anything gets modelled, the
> question is whether this is a valid panel at all."

Point at **Panel integrity**.

> "Duplicate account-date keys, gaps in the monthly sequence, rows recorded after
> a charge-off. None of those stop a model fitting. They produce a model that
> fits well and answers wrongly, which is worse. One flag here — a negative
> balance."

Open the **method** drawer beside Panel integrity. Leave it up for three seconds
and close it.

> "Every number in this product has one of those."

---

## 2:15 — The leakage guardrail (2 minutes) — **the first big moment**

**Click:** Explore.

The ranking is sorted by information value. The top three are flagged red.

> "The screen ranks every candidate by information value. Three are flagged as
> leakage. `foreclosure_referral_flag` scores 7.4 — that's not a predictor, it's
> a restatement of the outcome, recorded at the point of foreclosure.
>
> Now watch what it does *not* flag."

**Click:** `current_ltv` in the list.

> "Current LTV scores 0.70. On the textbook bands anything above 0.5 says 'check
> for leakage' — so a naive rule flags this too, and it's the best variable on
> the book.
>
> We don't test the size. We test the **shape**. A contaminated variable
> concentrates the outcome into a tiny slice of the population. The foreclosure
> flag captures 97 times its share. Current LTV captures 4.6 times. Those aren't
> close, and the rule separates them."

Point at the amber *Review* banner, which says exactly that.

---

## 4:15 — The binning editor (90 seconds) — **the second big moment**

Still on `current_ltv`.

> "This is the binning. Bar height is the event rate, colour is weight of
> evidence — blue is safer, magenta riskier. Information value, 0.70."

**Drag** the third edge to the right by about an inch. Pause.

> "0.70 to 0.66. That's the whole model refitting on one-point-seven million rows
> while I drag. Merge two bins and you can watch what it costs you."

**Double-click** a bin to split it. The IV moves back up.

> "This normally takes a quant a morning in a notebook."

Point at **Monotonic ✓ decreasing** and **Economic sign ✓ matches prior**.

---

## 5:45 — Fit and backtest (2 minutes)

**Click:** the suggested variables in the tray — `current_ltv`, `fico_orig`,
`dti`, `occupancy`. Then **Model** → **Fit model**.

Three seconds.

> "Discrete-time hazard on every account-month. Test AUC 0.79, out-of-time 0.76."

**Click:** Specification.

> "This is the artifact that usually takes two weeks to write. Target definition,
> sample design — note it splits by **account**, not by row, because the same
> borrower appears in fifty rows and a random split leaks. Every coefficient with
> its standard error, p-value and variance inflation. And the EAD assumption in
> plain English."

**Click:** Backtesting.

> "Forty-four quarterly cohorts. Actual against predicted, with a Jeffreys
> credible band on the realised rate. The boundary is where out-of-time starts —
> the model never saw anything to the right of it."

Point at 2020.

> "It under-predicts the 2020 spike. We're telling you that. Seven of
> forty-four cohorts miss calibration, and rank order holds in seventy percent of
> periods. A clean chart here would mean we weren't looking hard enough."

---

## 7:45 — The macro layer (75 seconds)

**Click:** Scenarios → **Macro variables** tab.

> "The catalog is restricted to the Fed's supervisory variables. Not because
> they're the most predictive — because they're the only ones with a published
> **forward path**. A variable you can't project can't condition a stress test."

**Click:** the reconciliation panel.

> "FRED is monthly, CCAR is quarterly, the loan panel is monthly. We use
> Denton-Cholette benchmarking, and the derived monthly series aggregates back to
> the published quarterly value to machine precision. Not approximately —
> exactly. The residual is on screen."

Point at the seam on the left-hand chart.

> "And the join between history and the scenario is drawn, not hidden."

---

## 9:00 — ECL and the bridge (90 seconds) — **the third big moment**

**Click:** Scenarios & ECL → **Run scenarios**. Eight seconds.

> "Lifetime ECL, survival-adjusted, discounted. 35 million baseline, 129 million
> severely adverse."

**Point at the bridge.**

> "This is why the number moved. PD adds 58 million. Survival takes 7.5 million
> back — a book that defaults faster has fewer accounts left to default later,
> and most attributions bury that inside the PD bar. LGD adds 44 million. EAD is
> exactly zero, because this book amortizes on a contract that doesn't care what
> the economy does.
>
> The bars sum to the difference exactly. No plug."

---

## 10:30 — Drag the scenario (45 seconds)

Scroll to the **Scenario editor**. Drag an unemployment quarter upward. Click
**Apply**.

> "That's not the Fed's path any more, and it says so. Everything reprojects —
> PD, LGD, exposure, the bridge."

---

## 11:15 — Save, compare, and close on the roll-up (45 seconds)

**Click:** Versions → **Save current specification**.

> "`hardy-colonnade-28`. The name comes from a hash of the configuration, so the
> same specification always gets the same name — a duplicate is visible
> immediately. Export it, email it, re-run it: identical numbers to twelve
> decimal places. That's the reproducibility story."

Tick two versions to compare.

> "Metric deltas, the variable set difference, and coefficient sign flips called
> out — because a variable that changes direction when you add another one is a
> real finding, not a rounding difference."

**Press `0`.** Back to the roll-up.

> "Three books, one screen. And that amber flag I promised to come back to."

Point at it.

> "The severely adverse scenario takes commercial property growth four standard
> deviations outside anything our model was fitted on. We could just print the
> number. Instead we tell you that the response out there is extrapolation, not
> evidence — and that uncapping it makes the CRE loss 2.3 times larger.
>
> That's the difference between a model that produces a number and a model you
> can defend."

---

## The three hardest questions, and the answers

**"Your AUC is 0.79. Real books do better."**

Not out of time, they don't. In-time is 0.79 and out-of-time is 0.76, on a period
the model never saw. What matters more is the cohort chart: discriminatory power
ranges 0.70 to 0.83 across the cycle. A single headline AUC hides that, and a
model whose ranking decays through a downturn still shows a respectable one. Ours
is deliberately not tuned to the maximum — the data has an unobserved borrower
quality term in it, exactly as a real book does.

**"How do I know the model found the real relationship, and not an artifact of
how you generated the data?"**

Open `docs/GENERATIVE_TRUTH.md`. Every coefficient that produced the data is in
there, written straight out of the code so it cannot drift. The macro paths are
real FRED history, so the sensitivities the platform estimates are sensitivities
that genuinely existed — the 2020 spike falls out of unemployment reaching 14.8%,
it isn't drawn in. And the platform disagrees with the generator where it should:
house price growth fits with the *wrong sign* on the mortgage book, because
growth peaked in 2021-22 exactly when the book filled with young high-LTV
originations. That's a composition confound, the platform flags it as a sign
flip, and the fix is to let house prices reach PD through current LTV instead.

**"What's the EAD assumption, and why should I believe it?"**

It's different per book and it's on the specification card in plain English. The
two amortizing books use the contractual schedule — no credit conversion factor,
because there's no undrawn commitment to convert. The CRE book uses
`drawn + CCF x undrawn`, and the CCF is **estimated from your tape**, not
assumed: fixed-horizon twelve-month cohort, 19% on 240 facilities, with 10
excluded for having no headroom at the reference date. The exclusion is stated
because a CCF quoted without its sample definition isn't checkable.

---

## Reset

```
make reset
```

Deletes saved versions and regenerates the panels deterministically. Safe to run
between back-to-back demos. Takes about six seconds; the backend re-warms in
another thirty.
