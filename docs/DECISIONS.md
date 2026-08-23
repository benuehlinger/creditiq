# Decisions

Choices made during the build, with the reason. Anything a validator could
reasonably challenge is here, with the answer.

---

## 1. Toolchain

**Python 3.12, pinned through `uv`.** The machine defaults to 3.14.6. Neither
`optbinning` nor `statsmodels` has complete wheel coverage there. 3.12 does.

**pandas pinned below 3.0.** pandas 3.0.5 installs cleanly, but `statsmodels` and
`optbinning` are still stabilising against it. A demo asset must start reliably in
a conference room, so the newer major version is not worth the risk.

**`optbinning` 0.21.0 installs cleanly**, so the fallback to a hand-written
monotone ChiMerge is not needed. Equal-width binning is used nowhere.

---

## 2. Colour — the KPMG palette does not pass as given

The six brand hexes were run through the dataviz validator as a categorical
palette. They fail:

```
[FAIL] Lightness band       #00338D L=0.359 · #483698 L=0.412 · #910048 L=0.424
[FAIL] Normal-vision floor  #005EB8 <-> #00338D  ΔE 13.2  (floor is 15)
```

This is the correct result. `#00338D`, `#005EB8` and `#0091DA` are three steps of
one blue ramp — they are not three identities. A brand ramp is not a categorical
palette.

**Decision.** Blue becomes the structural spine (chrome, sequential magnitude,
ordinal ramps). Identity is carried by a five-slot set snapped to passing values:
each brand hue angle held, lightness moved, slot orders enumerated, and the
passing set with the smallest drift from the brand hexes chosen.

| Slot | Hue | Light | Dark |
|---|---|---|---|
| 1 | blue | `#005eb8` | `#0061be` |
| 2 | teal | `#00a19f` | `#00a4a2` |
| 3 | magenta | `#940049` | `#bf0061` |
| 4 | sky | `#0091db` | `#0091db` |
| 5 | violet | `#5200ce` | `#6c2cff` |

All six checks pass in both modes, and slots 1-3 also clear the harder all-pairs
gate — which is required, because the three portfolios share scatter and
small-multiple forms on the roll-up. Consumer, mortgage and CRE therefore take
slots 1, 2 and 3. Series cap: five on adjacent forms, three on all-pairs forms.

Slot 1 light is the exact KPMG medium blue and slot 4 is the exact KPMG light
blue. Only violet and magenta move, because the brand values sit below the
lightness band floor.

**Brand verification.** Deep blue, medium blue, light blue, violet and green all
confirm against public brand references. Pink `#910048` appears in third-party
references, but the KPMG secondary set found alongside the violet lists purple
`#470A68` and light purple `#6D2077`. `#910048` is kept; the ambiguity is noted
here.

**Encoding calls worth stating.** Scenario severity is **ordinal**, not
categorical — baseline to adverse to severely adverse is an order. Vintage is
ordinal for the same reason. Both avoid an eleven-hue chart. Diverging statistics
(WoE, correlation) use blue-to-magenta so that red and amber stay reserved for
risk and warning semantics.

---

## 3. MEV series — every substitution, and why

Nothing in the MEV layer is synthetic. History comes from FRED's public CSV
endpoint, which needs no API key; that is what makes a genuinely offline demo
possible. All 26 series resolve with full coverage back to 1990.

| Variable | Requested | Shipped | Why |
|---|---|---|---|
| BBB corporate yield | `BAMLC0A4CBBBEY` | **`DBAA`** | FRED serves the ICE BofA index under a licence that truncates it to about the last three years. A panel starting in 2015 needs more. Moody's Baa is the Moody's equivalent of BBB and carries history from 1919. |
| Equity index | `WILL5000IND` | **`NASDAQCOM`** | The Wilshire series was retired from FRED and now 404s. `SP500` and `DJIA` are licence-truncated to ten years, which does not reach 2015. NASDAQCOM is the only broad US equity index on FRED with full daily history. It is tech-weighted, so it is a **weaker** proxy than the Fed's Dow Jones Total Stock Market path, and the UI labels it as such. |
| CRE price index | no clean equivalent | **`COMREPUSQ159N`** | FRED carries no level index for US commercial property. The BIS series is published as a **year-over-year growth rate** (the `159` suffix in the BIS naming convention), so the index level is reconstructed by cumulating that growth from a base of 100 over the first four quarters. The base is arbitrary; only shape and growth carry meaning. **This is the weakest link in the catalog** and the UI says so. |

`JPNCPIALLMINMEI` (Japan inflation) was discontinued in June 2021. It is an
international secondary variable used by no portfolio; the gap is recorded in the
manifest rather than hidden.

---

## 4. Frequency reconciliation

Canonical grain is monthly. Conversion is driven entirely by per-variable
metadata (native frequency, stock/flow, measure, aggregation rule) — never a
global rule.

Quarterly to monthly uses **Denton-Cholette proportional first-difference
benchmarking**, solved through its KKT system. The aggregation identity holds to
**2.8e-16 relative** at any magnitude, verified by test. Straight-line
interpolation is tested to *fail* the same identity, so the shortcut cannot creep
back in.

**Precision.** An unscaled KKT solve loses about eight digits on a series the
size of GDP. The target is scaled to O(1) before solving and two steps of
iterative refinement are applied. The assertion is relative, not absolute — a
series measured in billions cannot be held to 1e-12 absolute in float64.

**Growth rates are never interpolated.** Growth to level index, benchmark the
level, re-difference. Tested by a round trip.

**The GDP indicator was changed twice.** Inverted unemployment was tried first and
rejected: it swings four-fold in 2020 and produced monthly GDP growth near -100%
annualized. Real disposable income was tried next and also rejected: it spiked
420% in April 2020 on stimulus transfers. **Industrial production (`INDPRO`)** is
the textbook monthly indicator for GDP and is what ships. The lesson generalises —
a merely-correlated indicator is not good enough, because the proportional
objective copies the indicator's month-to-month shape into the result.

**Growth is measured over a trailing 3-month window**, not month-over-month.
CCAR publishes growth at a quarterly annualized rate; the monthly analogue of
that is a 3-month window. Month-over-month annualization multiplies every wobble
by twelve.

---

## 5. Scenarios

**Baseline and severely adverse are the Federal Reserve's published 2026
supervisory scenarios**, downloaded from federalreserve.gov and committed
verbatim. All 28 variables map cleanly; the horizon (13 quarters) is read from
the file, never hardcoded.

**The Fed publishes no adverse scenario.** It has not since the 2022 cycle — the
URL 404s for 2023, 2024, 2025 and 2026. The brief asks for three severities, so
CreditIQ **derives** an adverse path as a 50% severity interpolation between the two
published paths. It is labelled as derived everywhere it appears and is never
described as supervisory. The scenario editor lets a user replace it.

**Splicing — rebase only what needs rebasing.** An earlier version shifted every
variable to remove the discontinuity at the seam. That was wrong, and expensively
so: it capped severely adverse unemployment at 8.2% instead of 10.0%, because a
jump from an actual 4.1% to a projected 5.9% **is the shock arriving**, not an
artefact. The rule now is narrow. A variable is rebased only when our historical
proxy is a different index on a different arbitrary base — our reconstructed CRE
index reads about 151 where the Fed's reads 309.5. Rates, yields, growth rates and
the VIX are on absolute scales and are never touched.

---

## 6. The generative model

**A discrete-time hazard, not a rule.** Accounts live through months and a hazard
decides each month's outcome. That is the same frame the platform fits.

**Default is reached through a delinquency chain** (30 to 60 to 90 and so on),
with cure probabilities. The target is therefore a real definition, the
`delinquency_bucket` column carries real information, and the observed default
rate is emergent rather than drawn.

**Macro drivers are stationary changes, not levels.** This was a real defect found
during calibration. HPI roughly doubles over the panel, so its z-score trends; the
`current_ltv x hpi_level` interaction had its main effect fully cancelled by 2023
(0.62 against -0.38 x z where z reached 1.5), and out-of-time mortgage AUC
collapsed to **0.586**. Switching to year-over-year change restored it to
**0.758**. The cumulative level effect on a borrower is already carried correctly
by current LTV, which is measured against their own origination.

**Calibration is automated, not hand-tuned.** `creditiq.data.calibrate` bisects the
roll intercept to hit the target default-rate band and sweeps frailty against a
target AUC. The realised values:

| Portfolio | Default rate | Target | AUC in-time | AUC out-of-time |
|---|---|---|---|---|
| Consumer | 4.36 %/yr | 3-6 | 0.783 | 0.766 |
| Mortgage | 1.22 %/yr | 0.5-2 | 0.763 | 0.758 |
| CRE | 1.81 %/yr | 1-3 | 0.816 | 0.868 |

**CRE macro betas were damped.** At the first draft the CRE macro block moved the
hazard by more than two log-odds, which produced almost no defaults through 2022
and then a 15% office default rate in 2024. Real books do not have a seven-year
gap with no losses. The divergence is preserved; only its amplitude is reduced.
Office still runs to 10.5%/yr in 2024 against 2.8% for multifamily.

**The CRE tape ships a reported DSCR, not the true one.** A debt service coverage
ratio on a real loan tape is borrower-sourced from annual financials and is
routinely two to four quarters stale. The hazard responds to the true, current
coverage; the tape carries a stale, noisy blend. Without this, CRE AUC sat at
0.84 — discrimination no analyst could actually achieve. This is honesty about
the data, not a tuning trick.

**Known simplification: 2020 consumer performance.** The generator reproduces the
textbook relationship — unemployment up, defaults up — so consumer defaults spike
in 2020. Realised 2020 consumer credit performance actually *improved*, because
unprecedented fiscal transfers and forbearance broke that relationship. The
generator does not model policy response. The brief asks for a visible 2020
signature and that is what ships; this paragraph is the answer if the question
comes.

---

## 7. Information value has a small-sample floor

A planted pure-noise column in the CRE book scores IV 0.031, above the textbook
"not predictive" threshold of 0.02. That is not a bug in the plant. **IV is biased
upward in small samples** — ten bins against 356 defaults produces a null IV near
0.03 for a column with no signal at all.

The test suite therefore checks planted noise against a **permutation null**
rather than a fixed threshold. The Explore surface must do the same thing: the IV
ranking table quotes the null floor for the current sample, so an analyst does not
read small-sample noise as weak predictive power.

---

## 8. Repository

Repo root is `/Users/benuehlinger/helios`. Generated parquet is gitignored;
CSV samples and dictionaries are committed. The FRED key is never written to
disk — `.gitignore` covers `.env` and `*.key`.

**Docker is not installed on the build machine.** The compose stack is authored
and linted but has not been executed here. That is stated rather than reported as
a passing check.

---

## 9. Modelling choices made during the build

**The seasoning spline is QR-orthogonalized.** The raw hinge basis — the value
plus `max(value − knot, 0)` at each knot — is the obvious way to write a
piecewise-linear spline and it is catastrophically collinear: every hinge is a
truncated copy of the one before. Fitted directly it produced variance inflation
factors above 4,700 and a pair of coefficients of +21.5 and −21.8 that cancel to
nothing. Those numbers are not wrong, but no validator will accept a
specification card that shows them. A QR decomposition spans exactly the same
function space, so the fitted curve is identical while variance inflation drops
to 1.00. The individual weights then carry no separate meaning, which is honest:
a spline's shape is the quantity of interest, not its basis weights.

**The orthogonalizing map is persisted, not recomputed.** A projection ages
accounts past knots that were dead in the fit sample, which changes the column
count, and re-running QR on new data produces a *different* basis spanning the
same space — the fitted coefficients would be applied to the wrong vectors. The
knot set and the map are stored with the fit.

**Binning is fitted on an event-preserving sample.** Optimal binning is a
constrained optimisation; running it over 1.7M rows per variable cost about four
seconds of a two-second refit budget. A binning is a population statistic, and
fitting it on 300,000 rows moves the edges by less than the width of a bar. Where
the analyst has set edges in the editor, they are used verbatim and nothing is
refitted.

**Refit performance: 2.8 seconds, against a ~2 second target.** Reduced from 5.2
by caching WoE maps and transformed columns, building the design once instead of
twice, vectorising the account split and computing AUC and KS from a single sort.
One optimisation was tried and **reverted**: a hand-written mid-rank function to
replace `scipy.stats.rankdata`, on the assumption that scipy's per-call overhead
mattered. It was three times slower — averaging ties needs a pass over runs of
equal values, and that pass is C in scipy and a Python loop by hand. The target
was not reached; the fit-sample toggle and a real progress indicator are both
shipped, as the brief allows.

---

## 10. Three defects in the loss layer, found by looking at the output

**Realised LGD carried no macro term.** The coefficients were declared on the
portfolio specification and never applied in the generator, so severity had no
relationship to the cycle and the attribution bridge showed an LGD contribution
of −0.1M. This is precisely the failure the brief singles out as the most common
thing a validator catches. Severity now swings 0.09 to 0.21 on the mortgage book
between rising and falling house prices, and LGD contributes 44M to the bridge.

**Projected accounts have no workout duration.** The column is zero for every
open account, so imputing the median imputed zero — and the median of an all-NaN
column is NaN, which made every projected mortgage and CRE LGD come back NaN. A
projected default now takes the book's realised mean workout duration.

**The EAD step is exactly zero on an amortizing book, and that is correct.** The
schedule is contractual and does not depend on the economy, so exposure is
identical in every scenario. It reads as a bug, so the bridge explains it rather
than leaving a bare zero bar.

---

## 11. Extrapolation beyond the estimation window

The 2026 severely adverse scenario takes commercial property growth to −24% year
on year against a fitted floor of −10.7% — 4.3 standard deviations outside
anything the model has seen. A logit is linear in the log-odds of its inputs;
outside the fitted range that is extrapolation with no evidence and no bound. The
unconstrained model answered with a 33% cumulative default rate and a 19x stress
multiple.

CreditIQ reports the distance per variable and winsorizes the forward path to the
fitted range by default. That is standard practice and a real trade-off — it
keeps the projection inside the evidence and it also caps the stress — so both
numbers are shown. On CRE the uncapped figure is 2.3x the capped one.

---

## 12. Two sign problems, and why only one was a specification error

**The tornado's shock direction was wrong.** It took the adverse direction from
the way each variable moves in the severely adverse scenario. Mortgage rates
*fall* in that scenario — a flight to quality — so the shock pushed rates down
and the executive view reported that a worse mortgage rate cuts expected loss by
22%. Direction now comes from the economic prior.

**`hpi_yoy` fits with the wrong sign on the mortgage book, and dropping
`current_ltv` does not fix it.** With current LTV in the specification it fits
+0.399; without it, +0.120 and still significant. The second number is the
interesting one, because it rules out simple double counting. House price growth
peaked in 2021-22 at exactly the moment the book filled with young, high-LTV
originations climbing the seasoning ramp, so the *marginal* association between
price growth and default is positive even though the causal effect is negative.
That is a composition confound between the macro cycle and book vintage.

The resolution is not to constrain the sign — the term is measuring something
real, just not what it is named after. The mortgage specification now carries
unemployment alone, and the house-price channel reaches PD through current LTV,
which the projection recomputes on the scenario's own HPI path. Mortgage ECL
still triples under severely adverse, and every macro sensitivity on the roll-up
now moves the way economics predicts.

---

## 13. Colour decisions caught by the validator

Two charts were built with palette pairs that fail, and the validator caught both.

**Actual against predicted** was drawn in slots 1 and 4. Both are blues; the
palette's adjacent gate tests 1-2, 2-3, 3-4 and 4-5, so that pair was never
checked. It measures ΔE 14.5 against a floor of 15. Moved to slots 1 and 3, which
clear the harder all-pairs gate at 18.9.

**The macro splice chart** used the portfolio accent for "Actual". On the CRE book
the accent *is* slot 3, so "Actual" and "Severely adverse" rendered in the same
colour. It now uses explicit slots 1-3.

The lesson generalises: a chart that derives one series colour from context and
another from a fixed slot can collide, and only the validator will notice.

---

## 14. Container

One image, one process, one port. The frontend is built in a node stage and
served by the Python app, so `docker compose up` starts a single thing and there
is no reverse proxy, second port or CORS configuration to get wrong in a
conference room. The synthetic panels are generated during the image build, so
the container is self-contained and needs no network at run time.

**Docker is not installed on the build machine.** The compose file is authored
and its YAML parses; the image has not been built or run here. That is stated
rather than reported as a passing check.


---

## 15. Branding: CreditIQ, and the two marks

**The product is CreditIQ.** The Python package was renamed from `helios` to
`creditiq` at the same time, so the codebase does not say one thing while the
screen says another. The repository directory is unchanged, because renaming it
would break paths on a running machine for no benefit.

**Two marks, never fused.** KPMG identifies who built the tool; CreditIQ
identifies what it is. They sit side by side separated by a rule and are never
combined into a single graphic — that would be inventing a co-brand nobody
approved.

**The KPMG mark is a stand-in.** The committed file is the Wikimedia Commons
vector, used so the layout is real rather than a grey box. It must be replaced
with the asset from the internal brand portal before this is shown to a client:
the mark is a registered trademark and the internal file is the authoritative
one. It is fetched at runtime, so swapping it is a file copy.

**Correction to an earlier claim here.** I first wrote that the file has no fill
and therefore inherits `currentColor`. That was wrong, and it was wrong because I
checked for a `fill="…"` ATTRIBUTE and the colour is in an inline STYLE on the
path — `style="fill:#003087;…"` — which beats a fill inherited from the parent
`<svg>`. The mark stayed KPMG blue on the dark surface no matter what the CSS
variable said. The component now strips paint declarations on load, leaving the
geometry ones alone, because dropping stroke-width or stroke-linejoin changes the
SHAPE of a trademark rather than its colour.

**On dark, the mark is REVERSED to white, not tinted blue.** #00338D measures
1.67:1 on the dark surface and is unreadable; a mid-blue tint leaves the four
thin square outlines fighting the background and reading as fuzz. Reversing a
logo to white on a dark ground is what every brand system specifies, and it is
what looks right here.

**Sizing is optical, not by bounding box.** The four squares occupy the upper
half of the artwork and the letters only the lower 55% — measured off the path —
so sizing by the box makes the type far smaller than it looks like it should be.
A 21px mark has 11px letters, which is why it sat awkwardly beside a 16px
CreditIQ wordmark. `KpmgMark`'s `height` now means the height of the LETTERS and
the component scales the box to suit, so the two marks share a cap height.

`CoBrand` drives both from a single `scale`, so they cannot drift apart when
someone adjusts one of them. The header runs at scale 1: a 22px cap in a 64px
bar, which is roughly double the effective size of the first attempt.

**The CreditIQ mark decodes.** Three ascending bars under a curve: a binning,
with a fitted hazard running through it. Those are the two things the product
does. The bars carry the same specs as every chart in the app — capped thickness,
rounded data ends, a surface gap between them.

**Space Grotesk is self-hosted.** One 22 KB variable file covers every weight.
A `fonts.googleapis.com` link would be a network dependency, and the brief
requires this to run in a conference room with hostile WiFi.

**The display face is for the wordmark and headings only.** Charts, axis labels
and every number stay in the system sans. The dataviz rules are explicit that a
display face on a hero figure reads as off-brand decoration, and tabular
alignment depends on the system metrics.
