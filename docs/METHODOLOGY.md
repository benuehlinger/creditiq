# Methodology

Every computed quantity in Helios, with its formula and its assumptions.

**This is a demonstration of capability. It is not a validated model, it carries
no regulatory approval, and nothing here should be read as an assertion of
SR 11-7 compliance. The data is synthetic and labelled as such throughout.**

---

## 1. The frame: a discrete-time hazard on account-months

Each row of the panel is one account in one month, at risk. The model estimates
the conditional probability that the account defaults in **that** month, given it
has survived to it.

```
logit( PD_i(t) ) = a + f(age_it) + B'x_i + G'z_t
```

`f(age)` is a seasoning spline, `x_i` are borrower attributes, `z_t` are
macroeconomic variables at that performance date.

This frame is chosen because lifetime expected credit loss needs a **term
structure** of conditional probabilities. A model fitted on "did this account
ever default" produces a single number per account and cannot be projected
forward month by month.

**References.** Basel Committee, *International Convergence of Capital Measurement
and Capital Standards* (IRB approach). Board of Governors, SR 11-7, *Guidance on
Model Risk Management*.

---

## 2. Weight of evidence and information value

For a bin `b` of a variable, with `e_b` events and `n_b` non-events:

```
WoE_b = ln( (e_b / E) / (n_b / N) )
IV    = SUM over b of  ( e_b/E − n_b/N ) x WoE_b
```

Three edge cases are handled explicitly, because they are what a validator asks
about:

**Missing values get their own bin.** Never imputed into a numeric bin.
Missingness is frequently predictive in credit, and folding it into the median
bin both loses that signal and misstates the bin's event rate.

**Zero cells take a Haldane-Anscombe correction** — half an observation added to
both cells of any bin with an empty one. A bin with no events has an infinite
WoE; dropping it instead makes the information value depend on sample size in a
way that cannot be explained in a meeting.

**Information value is biased upward in small samples.** The textbook bands
(under 0.02 not predictive, 0.02–0.1 weak, and so on) are quoted as though they
were sample-size free. They are not. The procedure being measured is "optimally
bin, then compute IV", and the binning step itself fits the permuted target. On
the commercial real estate book — 356 defaults — a variable with **no signal at
all** scores a null information value around 0.18, which is inside the "medium"
band. Helios estimates that floor by permutation and quotes it beside the
ranking.

### Binning

Optimal binning via `optbinning` where it resolves, with a monotone trend
constraint. The fallback is a ChiMerge-flavoured monotone merge over quantile
seeds — deliberately **not** equal-width binning, which puts most of a skewed
credit variable in one bin.

---

## 3. The leakage guardrail

A naive rule — "information value above 0.5 means leakage" — is wrong in both
directions. It fires on FICO, which legitimately scores 0.82 on the consumer book
and is the most defensible variable a scorecard can carry.

Leakage has a **shape**. An outcome-contaminated variable concentrates nearly all
the events into a tiny slice of the population, because it is a restatement of the
outcome. The discriminator is **maximum bin event-capture lift**:

```
lift(b) = ( events in b / all events ) / ( rows in b / all rows )
```

On the consumer book the planted `collections_referral_flag` reaches 126x, and
`delinquency_bucket` — a legitimate behavioural variable that is simply not
knowable at origination — reaches 275x. FICO, with a comparable information
value, peaks at 4.9x. The rule separates them cleanly.

Helios **flags**; it does not block. The judgement stays with the analyst.

---

## 4. Frequency reconciliation

The canonical grain is monthly. FRED is mostly monthly with some daily, weekly
and quarterly series; the supervisory scenarios are quarterly; the loan panel is
monthly. Every conversion is driven by per-variable metadata — native frequency,
stock or flow, measure, aggregation rule — and never by a global default.

**Higher frequency to monthly.** Collapsed by the variable's own rule:
period-average for rates, end-of-period where the supervisory definition is
end-of-period, and period-maximum for the VIX, which the Federal Reserve defines
that way.

**Quarterly to monthly.** Denton-Cholette proportional first-difference
benchmarking, against a monthly indicator series where a genuine one exists
(industrial production for GDP, Case-Shiller for the FHFA house price index):

```
minimise   SUM over t of  ( x_t / z_t  −  x_{t−1} / z_{t−1} )^2
subject to           C x  =  y        (the published quarterly values)
```

Solved through the KKT system, so the constraint is an **identity, not an
approximation**. The derived monthly series aggregates back to the published
quarterly value to 2.8e-16 relative, at any magnitude. Straight-line
interpolation between quarter-end points does not satisfy this, and the test
suite asserts that it fails.

**Growth rates are never interpolated.** A growth rate is a ratio of levels, and
the average of two ratios is not the ratio of two averages. The order is always:
convert to a level index, benchmark the level, re-difference. Getting this
backwards is the most common macro-modelling error.

**The monthly analogue of a quarterly annualized growth rate is a trailing
three-month window**, not a one-month one. Month-over-month annualization
multiplies every wobble by twelve.

---

## 5. Joining history to a scenario

Two different things meet at the seam, and only one of them is a problem.

**The problem is scale.** Where the historical proxy is a different index from
the Federal Reserve's variable, the two sit on different arbitrary bases — the
reconstructed BIS commercial property index reads about 151 where the Fed's reads
309.5. Such a variable is rebased multiplicatively, preserving the scenario's
percentage path exactly.

**Not a problem: a jump in a rate at the first projected quarter.** Unemployment
moving from an actual 4.1% to a projected 5.9% is the shock arriving. Shifting it
away caps severely adverse unemployment at 8.2% instead of 10.0%. Rates, yields,
growth rates and the VIX are on absolute scales and are never shifted.

The seam is drawn on every chart with a vertical rule and a distinct projected
line style.

---

## 6. Extrapolation beyond the estimation window

A logit is linear in the log-odds of its inputs. Inside the fitted range that is
an empirical claim; outside it, it is extrapolation with no evidence and no upper
bound.

The 2026 severely adverse scenario takes commercial property growth to −24% year
on year against a fitted floor of −10.7%, which is 4.3 standard deviations
outside anything the model has seen. Unconstrained, the model answered with a 33%
cumulative default rate over the horizon.

Helios reports the distance in standard deviations per variable, and offers
winsorizing the forward path to the fitted range. That is standard practice and
it is a real trade-off — it keeps the projection inside the evidence and it
**also caps the stress** — so both the capped and uncapped numbers are shown.
On commercial real estate the uncapped figure is 2.3x the capped one, entirely
from extrapolation.

---

## 7. Loss given default

A two-stage fractional response model, fitted on defaulted account-months:

```
P(loss > 0)          logistic
E[loss | loss > 0]   fractional logit, Bernoulli quasi-likelihood
E[LGD] = P(loss > 0) x E[loss | loss > 0]
```

Realised severity is not smooth and unimodal. A secured loan that defaults with
equity liquidates whole and loses nothing; the same loan underwater loses thirty
or forty points. On the mortgage book roughly half of all defaults take no
economic loss at all, and a single beta distribution cannot represent that mass
at exactly zero.

The second stage uses the Papke-Wooldridge fractional-response estimator, which
is consistent for the conditional mean without pretending a proportion is a count
of Bernoulli trials.

**LGD is scenario-conditioned.** Macro at default enters both stages. A downturn
LGD that does not move is the single most common thing a validator catches.
Realised severity in the generated data swings from 0.09 to 0.21 on the mortgage
book between rising and falling house prices.

---

## 8. Exposure at default

Deliberately **no single model across the three books**.

**Amortizing products** (consumer installment, residential mortgage). The balance
is projected on the contractual amortization schedule from the current balance,
the note rate and the remaining term, with an optional constant prepayment rate
haircut and a small arrears uplift. EAD at the default month is the scheduled
balance. No credit conversion factor applies, because there is no undrawn
commitment; applying one would invent an exposure that cannot exist.

**Revolving and committed facilities** (CRE revolvers, commercial lines).

```
EAD = drawn + CCF x undrawn
```

The CCF is **estimated from the tape** with the fixed-horizon 12-month cohort
method: facilities not in default twelve months before their default, measuring
how much of the then-undrawn commitment was drawn by the time they defaulted.

```
CCF_i = ( EAD_i − drawn_i(t−12) ) / undrawn_i(t−12)
```

Facilities with no undrawn commitment at the reference date are excluded — they
carry no information about drawdown and would pin the ratio at zero. On the CRE
book this yields 19% from 240 facilities, with 10 excluded. A regulatory-style
fixed factor is available as a toggle.

**The EAD method is stated in plain English on the specification card and carried
into every downstream number.** It is never an invisible assumption.

---

## 9. Expected credit loss

```
ECL_i = SUM over t of  MPD_i(t) x LGD_i(t) x EAD_i(t) x DF(t)

MPD_i(t) = PD_i(t) x PRODUCT over s < t of ( 1 − PD_i(s) )
```

**The survival adjustment is the step that gets skipped.** `PD_i(t)` is a
*conditional* probability — the chance of defaulting in month t given survival to
t. Summing conditional probabilities across a lifetime double-counts: an account
cannot default in month 30 if it already defaulted in month 12. Without the
running survival product, lifetime ECL on a long-dated book is materially
overstated. The test suite asserts that marginal probabilities never exceed
certainty, and that the naive version does breach it.

Discounting is at the account's effective interest rate.

**CECL lifetime is the primary frame** (ASC 326). **IFRS 9 staging** is a
secondary view: twelve-month ECL for stage 1, lifetime for stages 2 and 3, with a
significant-increase-in-credit-risk trigger at a doubling of the 12-month PD
since origination or an absolute 50 basis points.

---

## 10. The attribution bridge

Sequential substitution from baseline components to stressed, one at a time. The
bars sum to the difference **exactly**, with no plug — asserted in the tests.

Five steps rather than three, because a discrete-time hazard couples PD to
survival:

1. **PD (direct)** — the conditional hazard rises, survival held at baseline.
2. **Survival and mix** — the survival path itself changes. A book that defaults
   faster has fewer accounts left to default later, which **partly offsets** step
   one. Folding this into "PD" overstates the PD contribution on any long-dated
   book. The test suite asserts the two steps carry opposite signs.
3. **LGD** — severity on the stressed macro path.
4. **EAD** — the exposure path. On an amortizing book this is **exactly zero by
   construction**: the schedule is contractual and does not depend on the
   economy. It moves only with a rate-sensitive prepayment assumption or on a
   product with an undrawn commitment.
5. **Interaction** — the residual left by the ordering.

Sequential substitution is **path-dependent**: swapping LGD before PD attributes
the joint movement differently. That is a property of the method, and it is why
the residual is reported rather than absorbed. A Shapley decomposition, averaging
over all orderings, is computed alongside as an order-free check; it reaches the
same total.

---

## 11. Backtesting

Everything is computed per **performance-date cohort**, quarterly. A single AUC on
a random split says almost nothing about a credit model.

- **Actual against predicted** per cohort, with a **Jeffreys** credible interval
  on the realised rate. Jeffreys rather than the normal approximation because a
  cohort can have a handful of defaults or none, where the normal interval is
  either nonsense or exactly zero width.
- **AUC and KS per cohort** — discriminatory power is not one number.
- **Rank-order stability** — does the riskiest band stay riskiest in every period?
  Bands are scored globally so they mean the same thing in every cohort.
- **Score PSI and characteristic CSI** over time.
- **Vintage curves** — cumulative default rate by months on book, by origination
  year, computed through the survival product.
- **Segment backtesting** — slice by any categorical and report where the model
  underperforms.

**Sample design.** Train and test split by **account**, never by row: the same
account appears in dozens of rows, and a random row split puts the same borrower
on both sides so the model learns the borrower rather than the risk. The split is
by a hash of the account id, so an account never changes sides between refits.
Out-of-time splits by performance date. Binning, standardisation and WoE maps are
all fitted on train alone.

**Hosmer-Lemeshow** is reported with a caveat rather than as a verdict: the
statistic scales with sample size and will reject almost any model on a panel of
this size. The decile table is the thing to read.

---

## 12. Annualization

```
annual rate = ( 1 − (1 − monthly hazard)^12 ) x 100
```

Compounded, not multiplied. The two agree to a rounding error at the rates a
performing book runs at — 4.27% against 4.36% on the consumer book — but simple
annualization breaks down in the tail. A single quarter in a small, low-FICO bin
can carry a 33% monthly hazard, which multiplies out to a 400% annual default
rate. A book cannot lose 400% of itself in a year.

---

## 13. Model versions

A version is a portable JSON file holding everything needed to reproduce a fit.
Identity is a **content hash** of the canonical specification; the friendly name
is derived from that hash, so an identical specification always produces an
identical name and an accidental duplicate is visible immediately. Renaming never
breaks a reference, because nothing references the name.

Export, fresh import and refit reproduces every metric to 1e-12 — asserted in the
test suite.
