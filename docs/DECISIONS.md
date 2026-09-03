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
| BBB corporate yield | `BAMLC0A4CBBBEY` | **`DBAA`** | FRED serves the ICE BofA index under a licence that truncates it to about the last three years. A panel starting in 2008 needs far more. Moody's Baa is the Moody's equivalent of BBB and carries history from 1919. |
| Equity index | `WILL5000IND` | **`NASDAQCOM`** | The Wilshire series was retired from FRED and now 404s. `SP500` and `DJIA` are licence-truncated to ten years, which does not reach 2008. NASDAQCOM is the only broad US equity index on FRED with full daily history. It is tech-weighted, so it is a **weaker** proxy than the Fed's Dow Jones Total Stock Market path, and the UI labels it as such. |
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

**The Fed publishes no adverse scenario, so CreditIQ ships none.** It has not
since the 2022 cycle — the URL 404s for 2023, 2024, 2025 and 2026. An earlier
version filled the gap with a 50% severity interpolation between the two
published paths, labelled "derived" everywhere it appeared.

That has been **removed**. The label was doing all the work: on a chart the
invented middle line is indistinguishable from the two real ones, it sits between
them in exactly the place a reader expects a supervisory path, and it inherits
their credibility. Two scenarios that are both the Fed's beat three where one is
ours. A user who needs a middle path builds it in the scenario editor, where it
is their assumption and is marked as a custom path throughout.

### The panel starts in 2008, not 2015

A model estimated on 2015-2025 has never seen a downturn. Every supervisory
scenario is then extrapolation, and the only available defences are bad ones:
winsorize the path, which caps the stress, or overlay judgement, which is where
the number stops being a model output. The fix is not a technique. It is
estimating on a window that contains a crisis.

Moving the panel open to January 2008 does exactly that, and the extrapolation
panel shows it:

| | fitted range, 2015 panel | fitted range, 2008 panel | severely adverse |
|---|---|---|---|
| `cre_price_index_yoy` | −10.7 … 15.6 | −29.9 … 15.6 | −24.1 … 4.0 |
| `hpi_yoy` | −0.3 … 20.8 | −12.8 … 20.8 | −16.3 … 6.5 |
| `bbb_yield` | 3.2 … 6.6 | 3.2 … 9.2 | 4.5 … 8.3 |

Commercial real estate now has no variable outside its estimation window. On the
previous panel the supervisory property-price path sat 2.1 standard deviations
beyond the fitted floor and 60% of the stressed loss came from outside the
estimation range. Mortgage house prices remain 0.5 standard deviations past the
floor, and constraining the path changes severely adverse ECL by 2% rather than
33%.

**Underwriting quality is a function of the vintage, and part of it is
unobservable.** The 2006 and 2007 mortgage vintages performed materially worse
than their reported FICO and LTV alone account for. Documentation standards,
silent second liens and appraisal practice are not columns on a loan tape. The
generator represents both components: `vintage_attr_shift` moves the reported
attribute, so a model can learn that part from the drivers already available,
and `vintage_logodds` is the residual, which is observable only as a vintage
effect.

**Amplitude was recalibrated, shape was not.** At the old parameters the crisis
in the extended window produced 11.6%/yr mortgage defaults in 2009 and 23.3%/yr
on commercial real estate. Neither asset class has ever produced those numbers.
The driver, macro, interaction and vintage blocks were scaled down together — so
every relative effect is preserved — and the intercept then restored the
benign-period rate. What ships:

| | benign (2013-19) | 2009 peak | multiple | held-out AUC |
|---|---|---|---|---|
| consumer | 3.3%/yr | 9.2%/yr | 2.7x | 0.783 |
| mortgage | 1.1%/yr | 5.1%/yr | 4.7x | 0.797 |
| commercial real estate | 1.1%/yr | 6.1%/yr | 5.7x | 0.742 |

**The calibration harness was measuring AUC in-sample.** It fitted and scored on
the same rows. That read about four points high — the design carries 144 metro
dummies and seven seasoning knots, so there is plenty of noise to fit — and,
worse, it did not respond to frailty at all, because the model was fitting
exactly the variance frailty had just added. A calibration knob that does not
move the number it exists to move stays invisible until someone checks. The
first attempt at a fix then sliced sorted row indices, which produced an
out-of-time split labelled as in-time, and read six points low on mortgage. Both
are corrected; the split is permuted before it is taken.

**2020 is deliberately left unadjusted.** The consumer model implies 2020 should
have been among the worst years in the panel, because unemployment reached
14.8%. It was not: income support and forbearance programmes broke the
historical relationship between unemployment and consumer default. The generator
does not represent those programmes, and neither does a macro model estimated on
this data. It is retained as an illustration of the conditions under which a
management overlay is applied.


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
and then a 15% office default rate in 2024, a pattern no commercial book
exhibits. The divergence is preserved and its amplitude reduced.
Office still runs to 10.5%/yr in 2024 against 2.8% for multifamily.

**The CRE tape ships a reported DSCR, not the true one.** A debt service coverage
ratio on a real loan tape is borrower-sourced from annual financials and is
routinely two to four quarters stale. The hazard responds to the true, current
coverage; the tape carries a stale, noisy blend. Without this treatment CRE AUC
was 0.84, which overstates the discrimination achievable from a real loan tape.

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
piecewise-linear spline and it is severely collinear: every hinge is a
truncated copy of the one before. Fitted directly it produced variance inflation
factors above 4,700 and a pair of coefficients of +21.5 and −21.8 that cancel to
nothing. Those estimates are not incorrect, but they are not presentable on a
specification card. A QR decomposition spans exactly the same
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

A logit is linear in the log-odds of its inputs. Inside the fitted range that is
an empirical claim; outside it, it is extrapolation with no evidence behind it
and no upper bound. On the old 2015-2025 panel the 2026 severely adverse
scenario took commercial property growth to −24% year on year against a fitted
floor of −10.7%, and the unconstrained model answered with a 33% cumulative
default rate.

**Extending the panel to 2008 is what actually fixed this.** Commercial real
estate now has nothing outside its estimation window at all, and on mortgage the
remaining breach is half a standard deviation. The panel below is still shipped,
because a future scenario can always leave the window again and the caveat has to
be visible when it does. In the present configuration it is usually empty.

**The default is the Fed's published path, unmodified.** Constraining it is
offered as a switch, and both figures are always priced, but it is off.

It used to be on. That was a mistake, and a bad one: the screen said "severely
adverse" while the run clipped commercial property growth from −24.1% to −10.7%,
which removed 60% of the CRE loss and took the stress multiple from 14.3x to
6.1x. A defensible technique became a misleading headline the moment it became
the default. On today's panel the same switch moves mortgage ECL by 2%.

The extrapolation panel reports the distance per variable in standard deviations.
It now inspects the **LGD drivers as well as the PD macro terms** — mortgage
takes house prices through severity, not through the hazard, so a third of the
mortgage effect was happening with the panel reporting nothing out of range.

The real fix was not the switch. It was estimating on a window that contains a
downturn — see "The panel starts in 2008, not 2015" above.

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
combined into a single graphic, which would constitute an unapproved
co-brand.

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

## 16. A model is a PD specification together with an LGD specification

The Model ID previously covered the PD specification alone. Expected credit loss
is the product of PD, LGD and EAD, so an identifier derived from the PD
specification does not identify what produced the loss figure. Two versions could
share an identifier while carrying LGD specifications that differ by twenty
points of severity in a downturn, and the difference would appear only in the
loss number.

The Model ID now hashes both specifications, and a model with only one of them
cannot be named. Until both are fitted the interface shows the working hash and
states which specification is outstanding. Saving a version without an LGD
specification returns that reason.

**The LGD drivers are a specification rather than a constant.** `LGD_DRIVERS`
was a hardcoded list per portfolio. It remains the documented default, but the
drivers are selected on the LGD surface and the fitted model is cached on the
specification hash rather than on the portfolio key. Cached on the portfolio key,
one analyst's severity model would be returned to every subsequent request.

**The LGD model is a single fractional logit.** E[LGD | X] = sigmoid(X·β),
estimated by the Papke-Wooldridge fractional response quasi-likelihood on
`lgd_realised`. Terms enter linearly. The estimation population is defaulted
account-months, which on the commercial book is 381 rows; a binning and
weight-of-evidence apparatus over that many observations would add parameters
without adding information, so none is offered.

A two-stage form — P(loss > 0) multiplied by E[loss | loss > 0] — models the
mass of defaults that resolve with no loss explicitly. It was implemented
earlier and is not in use. The single fractional logit is sufficient for the
conditional mean, which is the quantity the loss calculation requires. The
zero-loss share is reported as a descriptive statistic so the size of that mass
remains visible.

The macro response is reported directly: mean predicted LGD with each macro
driver moved one standard deviation in each direction. On the commercial book a
one-standard-deviation fall in commercial property prices moves mean predicted
severity from 27.7% to 61.3%. A severity model whose predictions do not move
here will not move under a scenario.

## 17. Saved models are immutable, can be reopened, and record the data they were fitted on

Four related defects, with one cause: no surface stated which model it was
displaying.

**A saved model could not be reopened.** The version list showed names and
metrics with no route back into the specification. Each version now has an
`open` action that replays the specification — variables with their binning maps,
macro terms with lags, LGD drivers, sample design — and applies it to Explore,
PD, LGD, Scenarios and the roll-up. It replays rather than displaying stored
results: if the replayed specification produced a different Model ID, the inputs
or the engine would have changed since it was saved. The round trip is asserted
in the test suite.

**No surface identified the model it was showing.** A PD model could be fitted on
one screen, a different specification projected on another, and a saved version
opened on a third, with each internally consistent and each producing different
figures. A model context bar now sits below the navigation on every surface.

**Editing a saved model modified it in place.** A saved version is immutable. Any
edit while one is open raises a confirmation stating that the change creates a
new Model ID, and records the open version as the parent.

**Restoring a version has to restore the surfaces, not only the store.** The
macro terms, estimator, out-of-time date and sampling flag are local state on
the PD fit surface. Restoring the store alone left them at their portfolio
defaults, so the replay estimated a different specification, produced a
different hash and a different name, and the surface reported a model that was
not the one opened. On the commercial book that meant two macro terms instead of
one. The surface now hydrates its controls from the specification being
restored, and the fit waits until they match it.

When the replayed identifier still differs from the recorded one, the model bar
says so. That condition means the data, the specification format or the
estimator changed after the version was written, and the figures on screen are
not the ones the version stores.

**Every surface re-estimates on arrival.** Opening a version populates the PD
specification card, diagnostics and backtest, the LGD coefficients, macro
response and calibration, and the scenario projection, without further clicks.

**A version can be superseded or removed.** A hash is derived from the
specification, so a changed specification cannot keep the old hash. *Update*
saves the new specification, transfers the superseded version's status, tags and
starred flag to it, re-points anything that recorded the superseded version as
its parent, and removes it. *Save as a new version* keeps both and records the
open one as the parent. *Delete* removes the file, behind a confirmation that
states what is lost.

**A version now records the data it was fitted on.** A specification reproduces
exactly against a different panel and returns different coefficients, a different
AUC and a different loss figure under the same identifier. Moving the panel start
from 2015 to 2008 left seven saved versions whose stored metrics described a
dataset that no longer existed, with no indication of that on screen. Each
version now carries a fingerprint of the panel build, and versions from a
superseded panel are marked as stale in the list.

## 18. Explore is a stage of building a model, not a destination

The navigation previously offered Data, Explore, PD model, LGD model, Scenarios
and Versions, which left Explore unattached to either model. It is now grouped:
each model has an Explore stage and a Fit stage, and the grouping is shown in the
navigation.

The two Explore stages differ in population and in target, and everything else
follows from that:

| | PD model — Explore | LGD model — Explore |
|---|---|---|
| population | every account-month | defaulted account-months only |
| target | `default_flag`, binary | `lgd_realised`, a proportion in [0, 1] |
| bucket statistic | event rate | mean severity |
| interval | binomial | from the within-bucket spread |
| reference scale | log-odds | logit of the mean |
| candidates ranked by | information value | Spearman rank correlation |
| transformations offered | WoE, bins, continuous, spline | none; terms enter linearly |

## 19. Which view determines a variable treatment

The optimal binning produces six to eight bins. That resolution is required for a
weight-of-evidence table and is too coarse to locate a change of slope: several
of those bins may cover a linear run with the change inside one of them.

Three views are shown for every variable, whatever treatment is selected: the
distribution, the event rate across the variable, and the number of observations
behind each part of that rate. A bucket rate is interpretable only alongside its
volume, so the volume shares the x-axis with the rate panel. It does not use a
second y-axis, which would invite a comparison between two different scales.

The fourth view determines the treatment and is drawn on the log-odds scale
rather than the rate scale, because a logistic regression is linear in the
log-odds. A relationship that is linear on that scale is the one a continuous
term represents exactly.

| shape of the curve | treatment | reason |
|---|---|---|
| approximately straight | **continuous** | one column represents it |
| a smooth change of slope | **spline** | knots are placed at the change |
| a change of direction | **bins** | no other treatment permits one |
| monotone but curved | **weight of evidence** | one column carries the shape |

Knots are placed in this view, and moving one reports the spline R-squared
against the straight line's. On mortgage current LTV, moving the fourth knot to
the change of slope near 90 takes the spline from 0.988 to 0.996, against 0.903
for a straight line.

**Direction changes are counted with a zigzag filter.** Counting sign changes in
the differences reported eight direction changes for FICO, a variable a straight
line accounts for 97% of, because each bucket varies within its own confidence
interval. A direction change is now recorded only once the move against the
running extreme exceeds a threshold set by the estimation error. Two errors in
that function were found during implementation, both silent. The first extended
the running extreme before testing against it, which makes the move against it
identically zero and prevents any direction change from being recorded. The
second did not establish a direction on the opening leg, so a rise followed by a
fall recorded no direction change at all.

## 20. Macro is an input, not a model stage

The navigation groups the workspace by what each surface is *about*:

```
Data  |  Macro  |  PD model (Explore, Fit)  |  LGD model (Explore, Fit)  |  Scenarios  |  Versions
```

Macro sits beside Data rather than inside it. The two are different objects with
disjoint diagnostics. Data is the loan tape: one row per account-month,
missingness, cardinality, the target definition. Macro is thirteen shared monthly
series whose questions are stationarity, autocorrelation and lag — none of which
means anything for an account attribute, and all of which are essential here. A
single surface covering both would carry two toolbars that never interact.

It is built once and consumed twice, which is the point. The same term means the
same quantity in the PD hazard, in the LGD severity model and in the scenario
projection, because all four paths build it through `apply_mev_transform`.

### The search

Thirteen supervisory variables × five transforms × five lags = 325 candidates.
Only variables the Federal Reserve publishes a forward path for are offered: a
term with no projected path cannot be carried into a scenario, so it cannot enter
a model that has to be stressed.

Three filters reduce them.

**Stationarity.** A regression of one trending series on another finds a
relationship whether or not one exists. This is the filter the search exists for,
and it removes most `level` forms: 246 of the 325 candidates are stationary by an
augmented Dickey-Fuller test at 0.05, and the ones that fail are almost all
levels.

**Autocorrelation.** A correlation between two smooth monthly series is not
estimated on 216 independent observations. The reported significance uses the
Bartlett-Quenouille effective sample size. It changes conclusions: on commercial
real estate the BBB yield in levels correlates with realised severity at +0.63
across 381 defaults, and its effective sample size is **6**, so p = 0.17.
Unemployment as a three-month annualised change at nine months' lag correlates at
+0.65 with an effective sample size of 158 and p below 0.001. Without the
adjustment both read as certainties.

For severity the correlation is computed **per resolved default**, with the macro
term joined at the default month — the population the LGD model is estimated on.
A monthly mean was the first attempt and does not work: the commercial book
resolves 381 defaults across 216 months, so a monthly mean reaches five
resolutions in only fourteen of them. The effective sample size is capped at the
number of distinct months, because a macro variable takes one value per month and
a hundred defaults in one month carry one observation of it.

**Sign.** Where the portfolio declares an economic prior for the base variable,
the observed direction is checked against it.

Selecting a term puts it on a shortlist. It becomes a *candidate* in the Explore
stage of each model; nothing is added to a specification automatically.

### A defect the search exposed before it shipped

`MevSpec` has carried a transform and a lag since the model surface was built,
and the historical path applied both. **The scenario path applied only the lag.**
A term fitted on year-over-year change was projected on the raw level. Nothing
raised: the coefficient was applied to a different quantity from the one that
produced it, and the only symptom was the loss number.

It was reachable before this work and unlikely to be reached, because the
interface offered levels only. Shipping a search that recommends transformed
terms would have made it the normal case. The transform is now factored into
`apply_mev_transform`, which the fit, the projection, the LGD design matrix and
the search all call, with a test asserting each declared transform actually
changes the series.

## 21. Variance inflation is a property of the design, not of the tape

The variable tray computed VIF from the inverse correlation matrix of the **raw
tape columns**. The endpoint took column names and nothing else, so the treatment
never reached the calculation and a variable reported the same inflation whether
it entered as a spline basis, as bin indicators, as a weight-of-evidence column
or as a continuous term. Those are four different designs.

On the consumer book `fico_orig` and `interest_rate` correlate at **−0.976** —
the generator prices the loan off the score, as a lender does — and the raw
number is about 21 for both. Measured on the columns the model actually
contains:

| specification | `fico_orig` | `interest_rate` |
|---|---|---|
| raw tape columns (what it showed) | 21.11 | 20.89 |
| fico spline, rate continuous | 1.85 | 20.71 |
| fico spline, rate binned | 3.41 | 2.39 |
| both weight of evidence | 9.32 | 9.22 |

Right in one case out of four. The spline reads low because the basis is
QR-orthogonalised, so four of its five columns sit at 1.0 by construction and
only the linear component carries the inflation. Binning reads low because
discretising discards the within-bin variation the two variables share.

**A multi-column term has no ordinary VIF.** Once a treatment emits five basis
columns or seven indicators, `1/(1 − R²)` is not defined for "the variable". The
generalisation is Fox and Monette (1992):

```
GVIF_j = det(R_jj) · det(R_−j−j) / det(R)
```

GVIF grows with the column count, so it is not comparable across terms of
different size. `GVIF^(1/2·df)` is, and is on the scale of a standard-error
inflation factor; squaring it returns the familiar VIF scale and reduces exactly
to the ordinary VIF for a one-column term. That is what the tray reports, with
the column count beside it.

**One implementation, two callers.** The design now records which term owns each
column at build time rather than leaving it to be recovered by parsing column
names, and both the tray and the fitted specification card compute from the same
function. Two numbers under one word that could disagree was the underlying
problem.

**The seasoning basis is included.** It is seven columns of months on book and is
in every fitted design, so a selected variable correlated with account age
competes with all of them. Excluding it would understate the inflation on exactly
the variables where it matters.

**Binned terms drop a reference level, and Missing is not it.** `k` bins produce
`k − 1` indicators; with an intercept present, keeping all `k` would make the
design singular. Missing carries its own indicator rather than being folded into
the reference, because an account with no value recorded is not an account in the
lowest bin.

## 22. The sign check on the macro search

An economic prior states which way a variable moves credit risk: higher
unemployment raises defaults, higher house prices lower them. The macro
transformation search reports each candidate's observed direction against that
prior, so a term that contradicts it is visible before it enters a
specification. A contradicted sign is almost always collinearity with another
term, not a discovery.

**A prior belongs to the variable, not to one transform of it.** The prior is
applied to every transform and lag of the base variable. Rising unemployment
raises defaults whether the term is read as a level, a twelve-month change or an
annualised growth rate, and lagging a series does not reverse its direction.

**A prior resolves under whichever name the portfolio uses.** A specification
names the series it actually fitted, which is sometimes the derived one — the
commercial book declares `cre_price_index_yoy`, not `cre_price_index`. The
search enumerates base variables, so looking the prior up under the base key
alone found nothing for those. Every commercial property candidate reported no
prior when one was on file. `prior_for` now tries the base key, then the `_yoy`
and `_growth` forms of it, then the base of a derived key.

**The check follows the target on screen.** The candidate table ranks against
either PD or LGD, and the correlation column changes with it. One shared check
read from the PD column put a red cross beside a positive LGD correlation:
`bbb_yield` at lag zero correlates −0.17 with the commercial default rate and
+0.63 with severity. The row now carries `pd_sign_ok` and `lgd_sign_ok`, and the
column shows whichever matches the visible `r`.

**No prior is not a failed prior.** `sign_ok` is three-valued. `None` means the
book declares no prior for that variable, so there is nothing to check against —
the interface draws an em-dash, the "Sign matches the prior" filter keeps the
row, and the term is not penalised. This is the majority state: 197 of 246
stationary commercial candidates have no declared prior, because a book declares
priors only for the variables its own credit story rests on. Because it is the
majority state, the column carries a visible legend rather than a tooltip alone.

## 23. One axis, not two — and every axis named

**The candidate-against-target chart is a single axis.** Both series are
z-scored: each is centred on its own mean and divided by its own standard
deviation, so the shared scale reads in standard deviations. That is what makes
one axis honest for two series in different units, and it is the dataviz
skill's prescribed alternative to a second y-scale. A dual axis is never used
anywhere in this application — two scales in one frame invite a comparison the
data does not support, because the apparent crossing point moves with whatever
ranges the author picked. Timing and turning points are readable from the
z-scored chart; levels are not, and the caption says so. The tooltip carries the
published value in its own units, so nothing is lost.

The unit shown is the unit the TRANSFORM leaves behind. A twelve-month change in
a yield is in percentage points, not in the yield's own unit, and a growth rate
is a percentage whatever the base variable measures.

**Every axis carries a title.** `yName`, `xName` and `gridFor` in
`charts/base.ts` place it identically everywhere and reserve the gutter, so no
call site guesses the padding. The y-title is rotated into the left gutter
rather than floated above the plot: a floated title is clipped by the grid as
soon as the chart is short, which is what happened on the macro series panel.
A rotated title runs along the plot's HEIGHT, so a long one is clipped in a
half-width card — those axes take the short form the card head already explains
("AUC / KS", "PSI").

**The rule is enforced, not remembered.** `EChart` runs `auditChart` in
development builds: it reads the option object and warns when an axis has no
title, or when two or more named series carry no legend. A `silent` series is
scaffolding — the transparent stack base under a waterfall — and is exempt.
A card that draws its own `<Legend>` beside the chart passes `externalLegend`.
Checking the option object beats a test that reads source text, because the
option is what actually renders.

## 24. Zustand selectors must return referentially stable values

A selector written `(s) => s.selectedVariables[key] ?? []` builds a NEW array
whenever the key is absent. Zustand compares snapshots with `Object.is`, so the
snapshot differs on every render, the component re-renders forever, and React
reports "the result of getSnapshot should be cached" followed by "maximum update
depth exceeded". The component then unmounts and the surface renders blank.

**The roll-up hit this on every load.** It has no portfolio key in its URL, so
`ModelBar` and `useProgress` always took the fallback branch and always minted a
fresh array. The executive view — the first screen of the demonstration — was a
blank page, and the cause read as a routing problem rather than a render loop.

Twelve selectors across eight files had the same shape. They now return `NONE`
and `NO_MAP`, two frozen values exported from the store, so a missing key gives
the same reference every time.

Related: `/:portfolio` matches any string, so a stale bookmark or a typed key
rendered a surface with no data and no explanation. Every portfolio route now
sits under a `KnownPortfolio` guard that redirects an unrecognised key to the
roll-up.

## 25. What number represents the LGD model in the version list

The version list reported PD only — variables, AUC test, AUC out of time — even
though a Model ID in CreditIQ covers a PD specification AND an LGD
specification, and the loss number comes from both. Half of what produced the
figure went unmeasured.

**Two columns, both out of time: calibration bias and RMSE.**

**Why out of time is not optional.** A fractional logit carrying an intercept
reproduces the mean of its fitting sample exactly. In sample, therefore, the
severity bias of every specification is identically zero — measured across
seven mortgage specifications it was 0.0000 for all of them, while the same
seven ranged from 0.008 to 0.286 out of time. An in-sample bias column would
have printed a perfect score for a model that overstates severity by 29 points.

**Why bias is the headline.** It is the only severity statistic that converts
into an error in the loss figure. Severity multiplies into expected credit loss,
so a model 28.6 points high against a book averaging 12 points overstates
lifetime ECL several times over. Rank ordering carries no such consequence: a
model can order every default correctly and still be wrong on the level.

**Why RMSE sits beside it rather than instead of it.** Bias is a mean, so
opposing errors cancel: a model 20 points high on half the book and 20 low on
the other half reports no bias at all. RMSE does not cancel. Together they
decompose the error — bias is the level, and the gap between the two is the
dispersion.

**On the objection that RMSE cannot separate candidates.** That was checked
rather than assumed, and it is false. Across seven mortgage specifications
out-of-time RMSE ranged 0.159 to 0.337 and ranked them identically to bias,
deviance R² and rank correlation. RMSE is not shown *instead of* bias because it
is uninterpretable, not because it is undiscriminating: 0.177 says nothing about
what the model does to the loss number.

Deviance R² and rank correlation are stored and appear in the comparison panel.
Deviance R² is not a list column because it goes negative out of time when a
model predicts worse than the book mean — informative, but it reads as an error.

**`zero` is a third comparison direction.** For a bias the good value is the one
nearest nothing, so neither the largest nor the smallest signed number wins.

**Books that cannot support the split** store the in-sample figures with the
basis recorded, and the interface marks them, rather than passing one off as the
other. Versions saved before this existed show a dash that says what it means.

## 26. Why the pair is the unit, and why each half is still visible

A Model ID names a PD specification and an LGD specification together. The
version list's rightmost column is a loss number, and expected credit loss comes
from PD, LGD and EAD. An identifier covering only PD would not identify what
produced that figure, so quoting a loss would require citing a pair of IDs
anyway — the joining problem moved onto the reader rather than solved.

**The combinatorial objection does not hold in practice.** m PD models by n LGD
models is the theoretical cost. The saved versions do not show it: four mortgage
versions produced three distinct PD specifications and three distinct LGD
specifications, not nine. The cross product only appears if someone deliberately
enumerates it, and nobody develops that way.

**The halves are independent, which makes reuse the normal workflow.** Severity
is fitted on resolved defaults and never sees the PD specification. Stripping
`hardy-pergola-22` from three PD variables and its macro terms down to one
variable and none returned an LGD identical in specification hash, in bias to
six decimals and in RMSE. So settling on a severity model and then iterating PD
against it costs nothing: open the version, change PD, save. A new pairing gets
a new Model ID, and because the name derives from the content hash, an identical
pairing always produces an identical name — the same pair cannot be saved twice
under two identities.

**Which creates the one real cost, so each half carries a visible identity.**
`measured-heron-84` and `hardy-pergola-22` reported the same LGD bias and the
same RMSE, and nothing said whether that was one severity model seen twice or
two that happened to agree. It was one: `69ecffd0`. That matters, because a
miscalibrated severity model is inherited by every version bound to it — here,
including the champion. Each row now shows `PD <hash>` and `LGD <hash>`, and a
component shared with another version is marked with the number of versions
carrying it.

`ModelSpec.pd_hash()` hashes the canonical form with the `lgd` key removed, so
it moves when and only when the PD side moves. `hash()` remains the identity of
the pair — the thing that is named, promoted and quoted.

**When to revisit.** If component-level ownership appears (a severity team
iterating independently), or an action that scores one PD against every LGD
candidate, the store should become two-level: components with their own lineage,
and a version as a binding of one PD, one LGD and an EAD method. That is how
model inventories are structured. Building it now would be scaffolding for a
workflow this application does not have.

## 27. Say what changed, not how many stages did

The working-draft bar read `edited in 3 stages — saves as nimble-sextant-93.
hardy-pergola-22 is unchanged.` Someone returning to that screen could not tell
whether they had forked deliberately, changed one variable, or arrived there by
accident. Three defects, all in the same sentence.

**A stage count is not an account of the work.** Adding one PD variable marks
PD explore AND PD fit as changed, so one edit reads as two stages, and adding
one LGD driver on top made three. The number described the machine's internal
state rather than anything the person did. The state machine already held both
sets — `originVars` against `picked`, `originLgd` against the current drivers —
and discarded them to keep a count. It now returns the added and removed names,
and the bar states them: `PD +foreclosure_referral_flag · LGD +hpi@yoy@3`. Long
lists collapse to counts, with every name on the tooltip.

**Provenance was missing a word.** `Working draft hardy-pergola-22` reads as
though the draft WERE that version. It came FROM it, which is the answer to "how
did I get here". The bar now says `Working draft from hardy-pergola-22`.

**A refit owed is now stated on the bar**, not left to be discovered at the save
button. Changing the specification without re-running the fit means what would
be written is not what the screen shows.

## 28. The LGD fit endpoint could not read what the application writes

Opening a saved model and pressing Fit LGD returned
`Error: [object Object],[object Object],[object Object]`. Two independent
defects, and the second hid the first.

**The request model rejected its own serialised form.** `LgdSpec` is frozen, so
it holds `treatments`, `edges` and `knots` as tuples of pairs and `to_dict()`
writes them as LISTS — the shape stored in every saved version. `LgdFitRequest`
declared them as mappings only, so posting a stored specification back failed
validation on all three fields. An interface that cannot read its own output is
the defect, not the caller; a `mode="before"` validator now normalises the
list-of-pairs form, and a test asserts both shapes produce an identical fit down
to the specification hash.

**FastAPI's `detail` has two shapes, and the client assumed one.** It is a
string for a raised `HTTPException` and a list of objects for a validation
failure. Five call sites read `.detail` and handed it to `new Error()`, which
stringified the list. Three rejected fields surfaced as three `[object Object]`
naming neither the field nor the reason — the error was unreadable exactly when
it had the most to say. `errorText()` now handles both and prints
`treatments: Input should be a valid dictionary; …`.

**A leftover label was also corrected.** The coefficient table showed a
categorical entering as `weight`. Weight of evidence is a log-odds ratio between
a bin's event and non-event shares, so it needs a binary target; severity is a
proportion with no non-events to take a share of, and the treatment was removed
from LGD. A categorical takes the `bins` path — one indicator per level less a
reference — and is now labelled `indicator`. The module docstring still
described four treatments including weight; it describes three.

## 29. "Invalid Date" on every time-axis tooltip

A `type: 'time'` axis reports its value to the tooltip as a millisecond
TIMESTAMP, not as the ISO string that went in. `month()` appended `'T00:00:00'`
to whatever it was given, so a number produced
`new Date("1767225600000T00:00:00")` — Invalid Date — and the tooltip header
printed that instead of a month.

It affected most charts in the application, because most of them use a time
axis: the realised default rate, actual against predicted, discriminatory power,
score stability, bin stability, the macro paths and the ECL projections. One
shared helper now accepts a string, a number or a Date. It also appends the time
only to a bare `YYYY-MM-DD`, which stops such a date being read as UTC and
landing on the previous day west of Greenwich.

**The series is genuinely monthly and is not smoothed.** The mortgage panel
returns 216 points for 216 months. The crisis reads as a smooth curve and the
years after it as a jagged one because of how many defaults sit behind each
point, not because of any filtering: 43 defaults a month through 2009–2011
against 6.6 a month through 2016–2019. With 6.6 defaults on 8,410 open accounts,
ONE extra default moves the annualised rate by 0.14 percentage points, so the
line jitters by around 40 per cent of its own level with nothing happening.
Through the crisis the same absolute jitter is a small fraction of a rate
sweeping from zero to seven per cent, so the eye reads it as trend. The
smoothness is the signal-to-noise ratio, and it is real.

## 30. Plain English in the status bar

`All surfaces show this specification, unmodified.` describes an implementation
detail — which components read which state — in a sentence no reader has a use
for. It now says `You have not changed anything since opening this model.`

The drift message had the same fault: `Nothing edited, but the replay produced
measured-heron-84 — the inputs have changed since this was saved` uses "replay"
as a noun for an operation the reader never invoked. It now says `You changed
nothing, but refitting gave a different model (measured-heron-84). The data or
the estimator has changed since this was saved.`

## 31. Backtest cohorts are quarters, and the axis now says so

Every backtest statistic is computed per performance-date cohort, and a cohort
is a QUARTER (`freq="QS"`). That is deliberate. A monthly cohort on the mortgage
book rests on about seven defaults, and an area under the curve or a calibration
test on seven events reports sampling noise rather than model performance. The
`min_n` floors in `models/backtest.py` enforce the same thing from the other
side: 400 rows for the calibration cohorts, 800 for rank-order stability. Bin
stability is quarterly for the same reason, with a 250-row floor. Vintage curves
group by origination YEAR.

The axes said "Performance month". They were labelled that way in a sweep that
added titles to every chart, from a constant in the chart file with nothing
tying it to the aggregation — so the chart asserted a frequency the data did not
have, over ticks reading January, April, July, October.

The fix is not a corrected constant. `COHORT_FREQ_LABEL` is published with the
backtest payload, and the chart builds its axis title from it. A chart that
reads its own frequency from the data cannot drift from it again.

The monthly labels that remain were checked against their sources rather than
assumed: the realised default rate is 216 points for 216 months, the spliced
macro paths step monthly, and the ECL projection is monthly over the horizon.

## 32. Monthly cohorts are offered, quarterly is the default

The model scores every ACCOUNT-MONTH — the prediction is per account per month,
and the fit uses all 2,086,517 of them. Only the REPORTING of backtest
statistics is grouped, so the grouping is a reader's choice and is now a toggle.
It costs no refit: the scored account-months are held on the cached run, and
only the grouping is redone.

**Nothing is lost by making it available, and speed is not the reason for the
default.** Re-cohorting the mortgage panel takes 1.84s monthly against 0.86s
quarterly, against about 6.5s to fit — a rounding error, and it is fetched only
when asked for.

**What IS lost is the ability to read the statistics.** Measured on the mortgage
panel:

| | points | median defaults each | calibration band | AUC across points |
|---|---|---|---|---|
| monthly | 216 | 9 | ±66% of the level | 0.30 – 0.95 |
| quarterly | 72 | 26 | ±38% of the level | 0.49 – 0.90 |

A monthly area under the curve reached 0.297. Below 0.5 means a model that ranks
BACKWARDS — riskier accounts scored safer. Nothing of the kind happened; nine
events cannot support the statistic. Presenting that to a credit committee
invites an explanation of a defect that does not exist. The credible band tells
the same story more honestly, because it is drawn: monthly, it is two thirds as
wide as the rate itself.

So quarterly is the default and monthly is one click away, with the cost stated
rather than the choice removed. Every card reports how many defaults sit behind
a point, so the reader can see why the bands move.

## 33. Refit reports what it did

Refit was working. It posted, returned 200, and produced a fit identical to the
one already on screen — because the specification had not changed. So no number
moved, no name changed, and the button was indistinguishable from a broken one.
A correct no-op that looks like a fault is a defect in the interface, not in the
model.

The button now states its outcome:

- unchanged specification — `Refitted nimble-sextant-93. The specification did
  not change, so the result is identical.`
- changed specification — `Refitted: nimble-sextant-93 → vivid-capstan-27.
  AUC (test) 0.983 → 0.983.`

The message clears as soon as the specification changes again, because it
describes a fit that no longer matches the screen. It is keyed on the request's
CONTENT: the request object is rebuilt on every render, so keying the effect on
the object itself would have cleared the message before it could be read.

Failures already surfaced. Silence on SUCCESS was the gap, and the identical-fit
case is the one that needed saying out loud.

## 34. Severity through time, on both LGD stages

The severity distribution shows the SHAPE of the target — a mass at full
recovery and a mass near total loss — and it is the right chart for that. It
cannot show when. Severity on a secured book follows collateral values, so it
moves with the cycle: commercial severity ran near 90 per cent through 2009 and
settles between 20 and 40 later. A driver earns its place by tracking that
movement, and a model is worth trusting only if its predicted level tracks it
too. So the time series sits BESIDE the histogram on Explore rather than
replacing it, and the same chart carries the predicted line on the backtest,
where the LGD stage previously had no chart at all — only a table of yearly
means, which cannot show a turn.

**Each point is a disjoint cohort.** A trailing window would fill every month on
a thin book, but adjacent points would then share most of their data, and a
reader who does not know the window is there reads the smoothness as precision.
Plotting zero for an empty month is worse still: it asserts that every loan
recovered in full, which is a claim the data does not make. The panels were made
large enough to fill a month instead — see section 37.

**The band is the standard error of the COHORT MEAN, not a binomial interval.**
Severity is a proportion per loan, but the quantity estimated here is an average
of proportions, and its spread comes from how much the loans in that cohort
differ from one another.

**A thin period is emitted as a HOLE, not omitted.** Omitting it left no trace,
so a time axis joined the points either side of it and drew a band straight
across months where nothing had resolved.

The floor is five resolved workouts, set against the interval rather than a rule
of thumb: the chart draws the 95 per cent interval of every cohort mean, so a
thin month arrives visibly thin rather than quietly wrong.

## 35. One binning editor, two models

The severity binning was a static table while the PD binning had a draggable
one. Rather than write the drag twice — two places for the gesture to drift
apart — the editor now takes a normalised shape and both books adapt into it.
The quantities differ (an event rate against a mean realised severity, a weight
of evidence against a logit shift) but the interaction is identical: drag an
edge, double-click a bin to split it, double-click an edge to remove it.

## 36. A stepper that changes a number and nothing else

The spline knot count had a stepper on PD and none at all on LGD, so on the
severity side there was no way to ask for a different number of knots. Worse, on
the PD side raising the count left the curve on its old knots until a separate
"place automatically" button was pressed — the number changed and nothing on the
chart did, which is indistinguishable from a control that does not work.

Asking for a different number of knots IS a request to re-derive their
positions, so the count now re-places them. It fires on a CHANGE rather than on
the value, so opening a saved model keeps the knots that model was fitted with
rather than having them overwritten on arrival.

The gesture line — drag a knot, double-click to add or remove — was present but
sat in a footer among four other notes and was not found. It now reads as a
marked hint on the panel it applies to, and names where the count lives.

## 37. Book sizes, and the dtype change that paid for them

A monthly severity chart needs a month to carry enough resolved workouts to
average. It did not. At the original sizes the commercial book filled SEVEN of
158 months and the mortgage book 139 of 211, so the line was mostly gaps.

**The books were made larger at UNCHANGED default rates.** This is a bigger
portfolio, not a worse one — inflating the rate to manufacture defaults would
have made every downstream figure unreal.

| book | accounts | defaults | rate before | rate after | months plotted |
|---|---|---|---|---|---|
| consumer | 50,000 | 5,254 | 4.18% | 4.18% | 214 of 214 |
| mortgage | 40,000 → 55,000 | 4,631 | 1.86% | 1.94% | 210 of 211 |
| commercial | 7,000 → 45,000 | 2,385 | 1.65% | 1.59% | 179 of 214 |

45,000 commercial loans is the top of the plausible range rather than outside
it: the largest banks run books of that order. It is needed because commercial
workouts CLUSTER — 24 a month through 2009, three to five a month mid-decade —
so filling the quiet years takes a book sized for them. The 35 months still
unplotted are in those quiet stretches, and that concentration is a property of
the asset class rather than of the generator.

**The dtype change is what made it affordable.** The mortgage frame held 1,445
MB, of which 1,036 MB was nine string columns — `msa`, `product`, `status`,
`occupancy` and so on, none with more than 144 distinct values and several with
two. A low-cardinality string costs about 55 bytes per row as Python objects and
about one as a categorical code. Converting them took the frame to 430 MB, and
all three books together now hold 1,318 MB where the old dtypes at the new sizes
would have needed roughly four gigabytes.

Floats are deliberately left at double precision. They are model inputs, and
narrowing them would move coefficients rather than only memory.

**The cost is fit time.** The mortgage panel grew from 2.09M to 2.87M
account-months and its fit from 6.5 to 10.1 seconds, spread evenly across the
design build, the estimation, the diagnostics and the backtest rather than
concentrated anywhere worth optimising. The "fast fit" toggle thins the sample
for anyone who wants the old speed, and says so on screen.

## 38. A button that only matters when nothing says so

"Does this button even do anything?" — a fair question about Refit on the LGD
stage, and the honest answer was "rarely, and never visibly".

The stage AUTO-FITS on arrival, so the ordinary path — set the drivers on
Explore, press "Go to Fit" — arrives at a fitted model with nothing left for
Refit to do. Pressing it re-estimated the same specification and returned the
same model, so no number moved.

But the Fit stage carries its OWN driver list, and toggling a driver there
changed the specification while leaving the previous fit on screen: the
coefficients, the diagnostics and the backtest all describing a model that was
no longer selected, with nothing to say so. The one moment the button mattered
was the one moment the interface stayed silent.

Both halves are now stated. The specification on screen is compared against the
one the fit was estimated on — drivers, categoricals, treatments, edges, knots
— and when they differ the row says `the specification changed — this fit is out
of date` and the button turns amber. When they agree, Refit reports what it did:
`Refitted. The specification did not change, so the result is identical.`
A genuine change reports the move: `Refitted: 16 terms → 17. Deviance R² 0.295
→ 0.295.`

**The previous result is held in a ref, not read from `fit.data`.** A mutation's
`onSuccess` closes over the render that created it, so `fit.data` inside it is
whatever it was when the mutation was defined — undefined — and every refit
reported itself as a first fit. The same trap sits behind the PD stage's
outcome message, which reads its previous result from component state instead.

## 39. Why switching books felt slower, and what it actually was

The panels did grow — mortgage from 2.09M to 2.87M account-months — but that was
not the cause, and measuring first mattered. Timing every request a portfolio
switch fires:

| endpoint | consumer | mortgage | cre |
|---|---|---|---|
| `/health` | 2.7s | **7.3s** | 4.4s |
| `/macro/library` | 1.2s | 1.2s | 1.2s |
| everything else | <0.1s | <0.1s | <0.1s |

**One endpoint was the whole story, and it was not cached.** `/health` runs
every integrity check and profiles forty-two columns across the full tape. It
returned in 6.7 seconds on the mortgage book — and it did so on EVERY call, on a
result that cannot change, because the panels are static for the life of the
process. It is also the first request a switch makes, since a switch lands on
the Data surface. So the cost was paid on every switch, and again on every
switch back.

Caching it takes a repeat switch from 7.4 seconds to **2 milliseconds**.

**A boot warm-up already existed and did not include it.** The startup thread
warmed the panels and the variable screen but not the profile or the macro
search — the two most expensive reads in the application. Both are now warmed,
so the first visit to a book is fast rather than only the second. The API
answers in 3 seconds and every book is warm within 10.

**A derived cache must not outlive its source.** The profile is built FROM a
panel, so it is stale the moment the panels are dropped. `store.clear()` now
clears registered dependents, which keeps one place responsible for being right,
and a test asserts the profile cache does not survive it.

**The size increase cost about 3 seconds on a refit, and nothing else.** Loading
a panel from parquet is 0.4–0.6 seconds cold and free thereafter. The category
dtypes from section 37 made the larger panels cheaper to hold than the smaller
ones had been.

## 40. The wordmark: Merriweather Light, and one mark fewer

Two changes to the header lockup.

**The product mark is gone from the header.** Two graphic marks either side of a
rule read as two logos competing, rather than as one attribution and one product
name. The wordmark alone sits against KPMG as an equal. The mark itself is kept
— it is the favicon, and it carries the hero lockup on a title slide, where it
stands alone and has nothing to compete with.

**The wordmark is set in Tinos Bold 700**, sized from the KPMG cap height
rather than from a fixed pixel value. KPMG's artwork is the fixed
quantity in this pairing — it cannot be redrawn to fit — so everything else is
measured off it. At 1.27x cap the serif reads as the same weight of statement as
the wordmark beside it; at the old 1.0x it read as a caption. The tight tracking
that suited the previous sans was dropped, because a serif at display size is
already spaced for it and the negative tracking closed the counters.

A light serif is the right register: KPMG's own wordmark is a heavy sans, and
answering it with another heavy sans turned the pairing into a contest.

**The font is bundled, not linked.** `@fontsource/merriweather`, imported at
build time from `node_modules`, which keeps the offline guarantee — a
`fonts.googleapis.com` link would put a network dependency in the header of an
application whose brief requires it to run in a conference room with hostile
WiFi. Only the LATIN subset is imported: the wordmark is one word in Latin
script, and the package also ships Cyrillic, Greek and Vietnamese cuts that
would be downloaded and never drawn. 47 KB in the built bundle.

The `@import` sits at the very top of `theme.css`. CSS requires `@import` to
precede every other rule, and placed after the existing `@font-face` it is
silently dropped — the page then renders in the Georgia fallback and looks
merely wrong rather than broken.

## 41. Size a wordmark by cap height, not by font size

The wordmark face changed from Merriweather Light 300 to Tinos Bold 700, and
the change exposed a latent bug in how it was sized.

The lockup multiplied the KPMG cap height by a constant to get a FONT SIZE.
That works for exactly one typeface. Tinos is metric-compatible with Times,
whose cap height is 0.67em against Merriweather's 0.72 — so the same multiplier
rendered letters 15 per cent smaller, and the wordmark that had balanced the
KPMG mark now sat visibly beneath it.

Cap height is now the unit. `brandSizeForCap()` converts to a font size through
`BRAND_CAP_RATIO`, measured off a rendered glyph rather than taken from a
specimen sheet: a canvas draws a capital and the ink is scanned for its top
edge. The lockups ask for the cap height they want and the ratio does the rest,
so the CreditIQ caps and the KPMG letters are both 22px and stay that way.
Changing the face means re-measuring one number.

**Vertical centring survived the change for a reason worth recording.** The
lockup centres the CAP BAND on the KPMG mark, and relies on the cap band sitting
at the centre of its own line box at `leading-none`. That is true of Merriweather
to within half a per cent and of Tinos to within one — but it is a property of
the face's vertical metrics, not a law. A face with an unusual ascender would
need an explicit nudge, and the measurement above is how to detect that rather
than discover it in a screenshot.

Bundled from `@fontsource/tinos`, latin subset only, 19 KB. The Merriweather
package was uninstalled rather than left in `package.json` as a dependency
nothing imports.

## 42. Two bugs behind "the treatment does nothing"

**A mapping was serialised as a list of pairs, and the interface spread it.**
`LgdSpec` is frozen so it can hash, which means it stores per-column settings as
tuples of pairs. `to_dict()` emitted that shape, so the interface received
`[["cltv", "spline"]]` for a field named `treatments` and wrote
`{...treatments, [col]: t}`. Spreading an ARRAY into an object literal yields
`{"0": ["cltv", "spline"], "cltv": "bins"}`; the request failed validation, and
NO treatment other than the default could ever be applied to a severity driver.
An implementation detail leaked onto the wire and cost the feature.

`to_dict()` now emits objects. `from_dict` still reads pairs, because saved
version files carry the old shape and a saved specification must stay readable.
On the interface side `asMap()` normalises on every read and `wireLgdSpec()`
cleans on every send — a specification persisted by an older build is repaired
rather than merely rejected.

**The PD stage discarded manual binning entirely.** The store held `treatments`
and `knots` but no `edges`, so dragging a bin edge or changing the bin count
updated the preview and was then thrown away: the fit ran on the server's
optimal binning, and the analyst's work never reached the model. The backend had
accepted per-variable `edges` all along — nothing sent them.

The bin COUNT is not itself part of a specification; the resulting EDGES are. So
changing the count pins the binning the server returns, which gives one
mechanism rather than two and makes a saved model reproduce the binning it was
actually fitted on.

## 43. A change is a change to the SPECIFICATION, not to the column names

The PD stage recorded only `variablesAtFit` — a list of column names. Rebinning
a variable, changing its treatment, moving a spline knot, switching estimator or
adding a macro term all leave that list untouched, so the stage reported itself
up to date while displaying a fit of something else. The severity stage compared
whole specifications and behaved correctly, which is why the two felt different.

`canonicalSpec()` reduces a request to a stable string: every variable with its
treatment, edges and knots; every macro term with its transform and lag; the
estimator, the out-of-time boundary and the sampling. Order-insensitive where
order carries no meaning — reordering the variable list is not a different
model, changing a treatment is.

It is compared against the specification stored WITH the fit, and read from the
store rather than from component state, so the warning survives a page reload —
a stale fit is exactly the thing someone returns to the next morning and does
not remember.

Both stages now say the same sentence, in the status bar and on the fit panel,
and both turn the button amber: *the specification changed — this fit is out of
date*.

## 44. The roll-up's model picker went stale

The roll-up carries the list of AVAILABLE versions for its per-book model
picker, and it is memoised on both sides — server-side because projecting three
books is expensive, client-side with `staleTime: Infinity` for the same reason.
Neither cache was dropped when a version was saved, deleted or promoted, so the
picker offered a set of models that no longer matched the versions page.

`rollup.clear_cache()` now runs in every mutating endpoint, and a test reads
those handlers' source to assert a new one cannot forget. On the interface side
the query keys a mutation must invalidate are named once, as `VERSION_QUERIES`,
rather than listed at each call site — the roll-up was the one that kept being
left out, because it is not on the screen where the mutation happens.

## 45. One candidate list, four places

The variable list was a different component in each of the four places it
appeared, and the differences were not deliberate.

**Macro variables were not in the PD list.** They were a row of chips on the fit
screen, so a macro term could not be examined or chosen where every other
candidate was, and PD macro selection lived in local component state — which is
precisely why the Explore stage could not offer them. Moving it to the store
made one list possible. They sit in their own section because they behave
differently, being the only terms a scenario can project, not because they are
chosen differently.

**The list did not survive the fit on the PD side.** The severity stage kept its
drivers beside the fitted model, so a term that came back insignificant could be
dropped and the model refitted without leaving the screen. The PD stage sent you
back to Explore. Both now keep it.

**The screening statistic was dropped at the fit.** Moving from the candidate
view to the specification view lost the number each variable was chosen on —
information value on the PD side, rank correlation and spread on the severity
side — which is exactly the number wanted when deciding whether to keep an
insignificant term. The statistic now travels with the row.

`SpecificationList` takes a normalised row and is used by all four. Membership
is a checkbox and examination is the row: one control doing both is how a
variable ends up in a specification when the intent was to look at it.

## One PD specification object

The PD specification lived in eight places: five fields in the store
(`selectedVariables`, `treatments`, `knots`, `edges`, `pdMevs`), and `maxBins`,
`nKnots`, `estimator`, `ootFrom` and `downsample` as local state on two
different surfaces. The LGD side always had ONE object, which is why it felt
like a coherent product and the PD side did not.

Three bugs came out of that scattering, and all three were the same bug:

- `maxBins` was local AND global — one value shared by every variable, reset on
  navigation. Changing the bin count and walking to the fit lost the change.
- Some fields were in the store and some were not, so a change to one was
  detected and a change to another was not.
- The fork guard could only wrap the mutations it knew about. It held on the two
  fit surfaces and not on the two explore surfaces, so a saved model could be
  silently rewritten by rebinning a variable.

`lib/spec.ts` holds one `PdSpec`: one place to read, one place to write, one
thing to diff, one thing to guard. `maxBins` and `nKnots` are per variable,
because a global bin count meant rebinning one variable silently rebinned every
other one.

## The fork guard lives in the store, not at the call sites

`editPd` and `editLgd` are the only doors. A saved model is immutable, so an
edit while one is open holds the change and raises `pendingEdit` for the shell
to confirm. Enforcing this in the store makes it true by construction: a
mutation that forgets to ask cannot be written, because there is nowhere else to
write. The per-surface dialogs and per-surface `guard()` helpers are gone.

## A bin count is a count, not a ceiling

`max_bins` was passed to `optbinning` as `max_n_bins` alone. A solver that chose
four bins under a ceiling of eight does not move when the ceiling drops to
seven, six or five — so the +/- control appeared inert, which is exactly how it
was reported. The editor now asks for a count (`exact_bins` puts the same number
on the floor). The count is not always available — a monotonic trend may not
survive the extra split — so the response carries `requested_bins` and
`achieved_bins` and the editor says which it got.

## The bin count is part of the specification

`VariableSpec` had no `max_bins` at all, so the count never reached the fit: the
analyst set seven bins, saw seven bins, and the model was estimated on the
library default of eight. It is now on the wire, in the design matrix, in the
WoE cache key, and in `VariableSpec.key()` — which is what the version hash is
built from. Without that last one, the same variable cut into seven bins and
into eight produced the same hash, the same auto-generated name, and overwrote
each other in the version store.

`tests/test_spec_identity.py` asserts the property against the dataclass rather
than a fixed list, so a field added later fails there instead of failing
silently in the version store.

## One canonical form, used twice

Staleness compared `canonicalSpec` (over the saved request) against `canonical`
(over the working specification). They were two hand-written functions listing
the same fields in different orders, so they could never produce the same
string: every model reported "the PD specification changed" the instant it
finished fitting, and a real change was indistinguishable from that noise.
`canonicalSpec` now routes the request through `fromRequest` and the one
canonical form. A function cannot drift from itself.

## Every book states its own state

Switching portfolios mid-model keeps the work — the specification is per book
and persisted — but nothing said so, so a half-built model looked exactly like
an untouched one. The portfolio switcher carries a per-book marker: filled means
fitted, hollow means in progress, accent means a saved model is open. Shape as
well as colour, so it survives a colour-vision deficiency and a black-and-white
print.

## The roll-up states its model coverage

A book with no promoted model still contributes ECL, from the documented default
specification. The page showed a green "Adopted models" pill regardless, which
overclaims: with one book fitted, most of the headline number is not a model
anyone here built. It now reads "1 of 3 books on a fitted model" and says which
books stand on the default and that those figures are computed but unreviewed.

## The binning editor had two sources of truth for one number

The stepper wrote a requested bin count. The chart drew the edges the server
returned. Nothing kept them in step, so removing an edge by hand left the
stepper on its old number, and pressing minus from that stale number asked for
a count the chart was already on and appeared to do nothing.

Both now read one number: the count actually drawn. A hand edit moves it, and
the stepper steps from it.

Underneath that was a worse bug. The editor kept a local copy of the edges so a
dragged handle would not wait for a round trip, and the effect that pushed the
copy back into the specification listed the parent's callback in its dependency
array. The parent passes a fresh arrow on every render, so the effect re-ran on
every render and wrote the stale local copy back 110ms later. Anything else
that changed the binning was overwritten a moment after it was applied, which is
why the stepper went dead as soon as an edge had been touched by hand. The
callback is now held in a ref, and the local copy is dropped whenever
authoritative edges arrive.

## One list on all four model stages

Three of the four stages used `SpecificationList`. The LGD Explore stage kept
its own ranking component, so severity drivers were chosen through a different
control, with no internal and macro split, and without the checkbox that
separates putting a variable in the model from looking at it.

## One name for the model on screen

The scenario stage labelled the loss figure with `fitted.name`, which is the PD
half only, one row below the bar showing the combined Model ID. The same model
appeared under two names at once. `useModelIdentity` is now the single answer to
what the model on screen is called, and both read it.

## Opening a saved version reported its own LGD as missing

The record stores no LGD hash and the frontend cannot derive one, so the restore
left it empty and the bar read "LGD model not fitted". The model has an LGD
specification and it is on screen: it has not been replayed in this session,
which is a different state and asks for a different action. The bar now says so.

## Prose

Text in the product is written for someone using it, not for the people who
built it. Removed: captions defending a rendering decision, captions describing
how the demonstration panel was generated, and captions explaining why a chart
is stacked or which colours it uses. Em dashes are gone from prose; in a heading
the separator is a colon. Repeated caveats are stated once, on the panel they
belong to. The word "surface" is developer vocabulary for a screen and no longer
appears in text the user reads.

The brand specimen page was a build tool on a live route. It is deleted, with
the dead lockup catalogue behind it.

## The roll-up across model types

The roll-up does not read stored numbers. It replays each selected version's
specification against the current panel, through the same projection the
Scenarios stage calls. So a treatment or estimator the replay cannot rebuild
fails on the executive page and nowhere else, and the path that gets exercised
by hand uses one estimator and weight of evidence.

Checked against all five PD treatments, all three estimators and all three LGD
treatments, with a different model type promoted on each book at once. The
roll-up total matched the Scenarios figure to the cent for every combination,
which it should: both call `scenario_service.run`. `tests/test_rollup_model_types.py`
pins each type, and pins that a specification stored and rebuilt from its
dictionary form still hashes and projects identically.

## A specification could name a column that does not exist

Found while building the matrix above. An unknown column passed straight
through: the design matrix skipped it, the fit succeeded, no warning was raised,
and the term was simply absent from the model. Because the hash comes from the
specification rather than from the design, the phantom column still changed the
hash and the generated name, so one model could hold two Model IDs with nothing
in the coefficients to show why. On the severity side one unknown driver
returned a model with no coefficients at all. Unknown columns are now rejected
at the API boundary, with the macro drivers exempt because they are joined from
the published series rather than read off the account panel.

## Tests must not depend on which model is promoted

Two tests read `rollup.spec_for(...)`, which returns whichever version is the
champion, and then asserted on its contents. Promoting a model, which is an
ordinary thing to do in the product, broke them for reasons unrelated to what
they check. They now build their own specification.

## Binned variables were not collinear; the table was reporting the wrong number

Bin indicators from one variable are mutually exclusive: a row in [710, 750) is
by construction not in >= 750. They are therefore mechanically negatively
correlated with each other and with the omitted reference bin, and each is well
predicted by its own siblings before any other variable is considered.

Measured on a four-bin fico term: per-column VIFs of 3.19, 9.00, 10.82 and
12.34 against a term-level generalised VIF of 1.80. The table painted a healthy
term red. Worse, the ranking inverted — interest_rate was the genuinely more
inflated term at 3.18 and showed smaller per-column numbers, so the table
pointed at the wrong variable to drop.

`generalised_vif` already existed with the correct Fox-Monette treatment and was
used on the Explore tray, not in this table. The coefficient rows now carry
`term`, `term_vif` and `term_df`, and the table reports the term figure with the
column count beside it; the per-column value is on hover. Same class of problem
as the rest of this pass: two places, two answers, one idea.

## The three books are now comparable in size

CRE was 96% of firm exposure at a mean commitment of $11.3M, so the roll-up was
a CRE chart with two invisible slivers on it and the tornado had one bar.

Exact parity is not reachable with credible loan sizes: CRE at $4B across ten
thousand loans is $400k a loan, and a $4B installment book needs about two
million accounts, which is sixty million rows. So the target is a realistic
regional bank rather than equality.

  book        exposure   share   mean loan
  consumer      $1.02B   10.8%      $39.1k
  mortgage      $4.31B   45.8%     $284.8k
  cre           $4.07B   43.3%     $402.5k

CRE is sized as small-balance commercial, which is a real product line. Its
commitment and net operating income were scaled by the SAME factor, so
loan-to-value, debt service coverage and utilisation are unchanged: property
value is balance over LTV and debt service is NOI over DSCR. The consumer book
carries three times the accounts at roughly two and a half times the loan size,
because an installment book is structurally small at a point in time — the loans
are short and most have amortised away by the as-of date. Annualised default
rates are unchanged at 4.10%, 1.94% and 1.59%.

## The data fingerprint could not see a change in the data

It hashed the row count, the account count, the default count, the window and
the seed. None of those move when the VALUES in a column change. The rebalance
above moved the mean commercial loan from $11.3M to $0.4M without moving any of
them, and every saved version still reported itself as current while its stored
loss figures described a portfolio 28 times larger.

The build now records a digest of the panel's numeric content and the
fingerprint consumes it. All four saved versions correctly report as stale, and
the roll-up marks the commercial champion "stale data".

## Three navigation levels, three forms

The Explore stage carried its own segmented control on the right of its card
header while the stage control sat at the far left of the bar above: two
controls, two levels of one hierarchy, at opposite ends of the window, neither
reading as the parent of the other.

Moving both into the model bar did not fix it. They still looked like siblings,
because they had the same FORM, and it left that bar doing four jobs at once:
stage navigation, view navigation, model identity and the primary action.

Two rules settle it. A tab belongs against the content it switches, not in a
toolbar with other things between it and that content. And a level of hierarchy
is distinguished by form, not only by position:

    section   Data · Macro · PD model …      text with an accent underline
    stage     [ Explore | Fit ]              filled segmented control
    view      Binning  Multicollinearity     underline tabs on the card edge

Binning and Multicollinearity are not places and they are not steps: they are
two lenses on one stage, which is what a tab is for, so the control sits against
the content it changes rather than in the navigation.

Which is where the actual problem was. FIVE places in the app were switching
views of a stage, and each drew its own control: both fit stages hand-rolled the
same row of pills, the scenario stage hand-rolled it twice within one file, and
the explore stage got underline tabs when I added it. One job, four
implementations, three of them copies. `ViewTabs` is now the only one, so the
question of how a view switcher looks has a single answer and cannot drift
again.

The view is held in the URL as `?view=`, so it is linkable and survives a
reload.

## The Explore header wrapped at any real zoom

It held a title, a sentence describing the stage, two tab labels of four words
each and the full sampling note on one flex line. At 1280px it wrapped to three
lines and the note ran under the tabs. The sentence is gone, because the
candidate list beside it already says what it ranks on; the tabs moved to the
bar; the sampling note is a caption, which wraps in its own block. The stage now
uses the same Card and CardHead the severity stage uses rather than an ad-hoc
flex row.

Also removed: the cardinality warnings printed twice on one screen, once in the
high-cardinality panel and again three rows below it.

## Clean and dirty: the specification is the source, everything else derives

The stages each decided for themselves what "out of date" meant, and they did
not agree. The result was a marker that could sit green on top of a dirty
specification: project a model, then rebin a variable. The projection still
matched the hash of the fit it was built on, because that fit had not been
re-run. What had moved was the specification underneath it, and nothing was
comparing against that.

There is one chain, and it is a chain:

    specification  →  fit  →  projection  →  saved version

The specification is the source and is current by definition. Everything below
it is derived, in that order. A link is `current` only when its own record
matches what it was built from AND every link above it is current. That second
clause is the whole point: without it, a derived artefact can report itself
healthy while its own input is stale.

So a change to the specification does not invalidate one thing. It invalidates
everything downstream, and getting clean again is a sequence: refit, reproject,
save. Each stage marker now reads its state off that chain rather than deciding
alone, and the note says which link broke and what to do about it.

Two things fell out of it. A projection that the model has moved on from is a
stale OUTPUT, not an unsaved change to the specification, so it no longer counts
toward the unsaved-changes tally; counting it there claimed unsaved edits
against a version nobody had opened, and the note then dereferenced a null.
And the navigation captioned every dot from a table of three generic strings, so
an amber Scenarios dot read "Changed since the saved model was opened" when no
model had been opened. Each stage already computes an accurate note; the
navigation now shows it.

## A fit survives leaving the stage

The fit RESULT lived in component state, so walking to Explore and back threw
away the coefficients, the diagnostics and the backtest, and a fitted model went
back to showing an empty "not fitted" state. The specification and the hash were
in the store; the expensive part was not.

The server already caches a run under its hash, so the PD stage now reads the
result from `GET /models/{hash}` keyed on the fitted hash. It survives
navigation and a reload, and it invalidates for free: the hash only moves on a
refit. A cache miss is a 404 and the stage asks for a refit, which is honest.

The severity stage had the same hole with a different shape. It re-estimated on
mount only when a version had been opened or the specification had just changed,
so a plain revisit after fitting fell through both conditions and showed the
empty state. It now re-estimates whenever it has drivers and no result. Severity
is fitted on defaulted rows only, so that costs little.

An out-of-date fit stays on screen rather than vanishing, under a banner naming
what changed. Blanking it would remove the thing a refit is compared against.

## PD Explore has the same shape as LGD Explore

The selected-variables tray was a third column on the PD stage with no
counterpart on the severity stage, so the two halves of the same job were laid
out differently. Both are now the candidate list and the detail panel, in the
same two columns and the same proportions. Variables are added and removed
through the checkbox in the list, which is how the severity stage already did
it, and variance inflation is on the Multicollinearity view and in the fitted
coefficient table.

## Prose gets a measure; the workspace stops stretching

Removing the third column left the detail column about 1,200px wide, and the
text in it simply filled that: captions ran to roughly 180 characters a line,
which is about three times a comfortable measure. That is most of why the page
read as stretched rather than spacious. A wide window was making the app harder
to read, not easier.

Two changes, both structural rather than per-screen. `CardHead` caps its caption,
which covers most explanatory text in the app in one place. Every remaining
long-form block carries the same cap, with centred blocks keeping their centring
through auto margins. The longest line of prose anywhere is now 665px against
1,527px before, on every screen.

The workspace itself is capped and centred. Past roughly 1,560px the columns
gain nothing and the eye has to cross the whole window to pair a label with its
value, so the content stops widening and takes margins instead.

## The stress multiple is not a measure of sensitivity

A multiple runs 6x to 9x on the secured books whatever specification is fitted,
which reads as a model that is wildly sensitive to the macro path. It is not.
Measured on a clean specification for each book:

  book        baseline    severe    multiple    12m PD mult   12m LGD mult
  consumer     377 bps    693 bps      1.84x         1.69x          1.00x
  mortgage      75 bps    447 bps      5.97x         1.57x          1.21x
  cre          189 bps   1217 bps      6.44x         1.29x          1.14x

The probability of default moves 1.3x to 1.7x, which is what the generator's own
macro coefficients imply: unemployment runs 4.6% to 10.0% peak on the published
severely adverse path, the panel's historical standard deviation is 2.24pp, and
a beta of 0.32 per standard deviation gives a hazard multiple of about 2.2x at
the peak. Nothing is over-reacting.

The multiple is large because the DENOMINATOR is small. A secured book loses
almost nothing in benign conditions, because collateral covers the loss: 75 bps
on the mortgage book. Its stressed loss of 447 bps sits inside the 200 to 800
bps a first-lien book carries over a three-year severely adverse path, so the
level is ordinary and only the ratio is dramatic. The unsecured book, whose
baseline loss is five times larger, shows the smallest multiple while carrying
the highest loss rate.

That is genuine credit economics rather than an artefact of synthetic data, and
it is why loss is reported in basis points rather than as a multiple. The
scenario stage now leads with the stressed loss and its rate, and the multiple
carries the explanation of what makes it big.

Two figures on that stage are 12-month and the ECL is 39-month, which is stated
where they appear: the supervisory path troughs in quarters six to eight, so the
12-month figures understate what the ECL reflects. That is most of the gap
between 1.9x on the twelve-month product and 6x on the horizon.

## Editing a specification does not re-estimate it

The severity stage re-estimated whenever the fitted hash was empty, and an edit
is exactly what empties it: every driver added or removed started a fit. Adding
three drivers meant three round trips, and the specification could not be
assembled before being estimated.

It now re-estimates only when it has a specification and no result at all: on
arrival, after a version is opened, and after the stage has been left and
returned to. An edit leaves the previous result on screen, marked out of date,
until Refit is pressed. That matches the probability-of-default stage, which
never fitted on its own.

Checked on all three paths: adding variables one after another on either fit
stage runs no fit, and with a saved model open the fork is asked once, on the
first edit, after which the draft is a draft and edits are free.

## One workbench per model

Model development is one loop, not two stages: look at a variable, add it, fit,
read the coefficients, click the weak one, rebin it, refit. Splitting that
across an Explore stage and a Fit stage produced the same complaint in a
different form every hour: the fit vanished on the way to Explore, variables
had to be added on the other screen, the view tabs had nowhere natural to sit,
a change on one stage had to be noticed by the other.

Each model is now one screen. The candidate list is the spine and never moves.
The right pane is whichever of three things is being looked at: the model (its
verdict, controls, coefficients, diagnostics, backtest), one variable (opened
by clicking it in the list or in the coefficient table), or the correlation
structure. The open variable and the view are in the URL. The Fit button is
beside the list. The old routes redirect.

This removed a navigation level, the third row of chrome, and the whole class
of "did my fit disappear" bugs, because there is nowhere for it to disappear
to.

## The verdict leads, and it is calibration first

A fit used to open on six equal tiles: version, AUC test, AUC out of time, KS,
Gini, McFadden. Four are discrimination, one is redundant (Gini is 2·AUC − 1),
and none is the number an ECL model is judged on. ECL is PD × LGD × EAD: a
mis-ranked model costs some accuracy, a mis-levelled one produces the wrong
dollar figure.

The model pane now opens on a verdict: one headline, then five rows in the
order a validator reads them. Calibration (level out of time, with bias and
coverage). Discrimination (AUC test and out of time, with the drop flagged: a
0.13 drop was previously two neutral numbers side by side). Stability (score
PSI). Economic sense (macro signs against the prior). Parsimony (insignificant
terms). Above them, a leakage banner naming any variable recorded after the
outcome that made it into the specification, because that model is not a
model whatever its numbers say. Every threshold is stated on the row's hover.

## Backtest error rates

The cohort chart showed predicted against actual and left the reader to
estimate the gap by eye. The numbers behind it are now a table, split at the
out-of-time boundary because the halves answer different questions: in time,
does the model describe the data it was built on; out of time, does it hold on
data it never saw. Bias, ratio, MAE, RMSE, coverage of the 95% band, and the
worst cohort, all in percentage points of annualised default rate, which is
the unit the answer is quoted in. Out-of-time RMSE, bias and coverage go on the
version record so versions can be compared on them.

## Ranking every lag of a macro variable is a trap

The macro search ranked 325 candidate terms by correlation, and the top six
were prime_rate at six different lags. The best of five lags of the same series
always looks better than any one of them, which is the classic route to a
spurious selection. The list now shows one row per variable and transform, at
its best lag, by default; the lags can be expanded.

## Smaller

Two rows of chrome rather than three: the model identity is one line at the
right of the section navigation, with the long form of every state on hover.
The candidate list is one line per row, and amber is reserved for leakage; a
list where most rows said "review" flagged nothing. The Data page leads with
its chart and puts the counts beneath it. The 4/8 progress counter is gone; the
dots on the navigation carry it, with accurate notes.

## The model is the hero

The verdict panel as first built was five full sentences in five columns, each
under a coloured pill, and it read as a wall. The model's own name, which is the
thing being worked on, had been demoted to a monospace tag in the corner.

The name is now the hero of the pane: large, with the hash, estimator, size
and fit time on one line beneath it, and the verdict as a single status at its
right. The five checks are one line of figures, one per check, with colour on
the icon only so the row reads as data rather than as five alarms. The sentence
and the threshold behind each figure are on the hover.

## The model band

A Model ID covers a PD specification and an LGD specification together,
because both produced the loss number. Nothing on screen showed that pairing:
the PD pane knew its half, the LGD pane knew its half, and the combined name
lived in a corner of the navigation.

The band sits frozen at the top of both workbenches: the model, its PD half,
its LGD half. Each half carries its identity, the one or two figures it is
judged on, and a status on the same thresholds the verdict uses. It stays in
view while the analyst scrolls through coefficients and backtests, which is
when the question "which model is this" comes up. The five-check verdict moved
to the Backtesting tab, where its evidence is; the leakage notice stays on the
model pane whatever tab is open, because a leaking model is not a model and
that cannot wait for a tab.

## Type and marks

The interface was set in whatever sans the machine had and drew every status
mark from whatever symbol font the machine had: a tick sat heavy beside light
text on one machine and thin on another, the circled i came out full-width on
Windows, and the hashes rendered in Menlo, which reads as a terminal.

Inter, self-hosted, in three weights: regular for text, medium for labels and
controls, semibold for headings and figures. JetBrains Mono for hashes, column
names and code. Both bundled from node_modules, so the offline guarantee holds.
Inter's slashed zero is on everywhere, because a zero in a hash must not read
as an O.

Every mark is an inline SVG on `currentColor`, drawn once in one file: check,
cross, alert, info, arrows, close. They take the text's colour and sit on its
baseline. The seven unchosen wordmark candidates, imported for a brand page
that no longer exists, are gone from the bundle.

The band is on the Scenarios stage too. It projects exactly that pair, and the
page used to restate the identity in its own words one row below the
navigation; the two had already drifted apart once, showing the PD name where
the Model ID belonged.

## Status is a dot and a word

The status mark was a tinted pill with an icon and a lowercase word. It read as
a sticker, and three of them on one line competed with the content they
described. Every status in the app is now a small dot and a word in the text's
own colour, sentence case, with colour on the dot alone; the word carries the
meaning, so colour never carries it by itself. The verdict checks use the same
mark. Alert banners keep their own bordered treatment, because those are the
few places prominence is the point.

## The fit, while it runs

A fit on three million account-months takes five to ten seconds, and a static
shimmer for ten seconds reads as a hang. The progress card now names the phase
that is running, over the count it is running over, and paces itself on the
previous fit's timings: the server reports six phases and how long each took,
so the estimate is grounded rather than invented. The bar eases toward the end
and holds there until the response arrives, then completes and stays for a
beat, so it is seen to finish. Where it states a time it says the time is an
estimate. The severity fit has the same card with its own four phases.

The same card runs the scenario projection (replay PD, replay LGD, project
every open account, build the bridge, paced by the projection's own timings)
and the roll-up (one phase per book, paced by each book's last projection).
The sub-second controls, such as regrouping a backtest, show a pulsing dot and
a word rather than a bar: a bar for half a second is a flicker.

## Switching models in place

The model's name in the band opens the saved models on the book. Choosing one
loads it on the current screen, and that screen updates to the chosen model's
results: on Scenarios the projection re-runs, on a workbench the fit is read
from the cache or replayed, and the band's figures follow. Two models are read
against each other by staying where you are and switching, which is how a
challenger is judged. Opening from the Versions page still goes to the model,
because that is the page's job. An edit after switching forks as before; the
guard is in the store and does not care how the model was opened.

## Switching models left the severity pane on the old one

After a switch in place, the store held the chosen model's severity half but
the pane kept the previous model's fit on screen, marked out of date, and did
not re-estimate: its rule was "fit when there is no fit". The analyst pressed
Refit to see the model they had just chosen, and until then the band and the
pane disagreed about which LGD was on screen. The pane now re-estimates when
the fit on screen is not the one the store holds. An edit clears the stored
hash rather than changing it, so an edit still waits for Refit.

## The draft survives a switch

Opening a version replaced whatever was being worked on, and there was no way
back: switching models to compare them cost the analyst the draft they were
comparing against. The draft is now put aside when a saved model is opened over
it, and the model picker offers it as "Working draft" until it is restored or a
new draft begins.

## A switch on the severity workbench wrote the old model over the new one

The severity pane keeps a local copy of the specification, synced from the
store in one effect, and re-estimates in another. After a switch in place both
run in the same pass, so the re-estimate saw the PREVIOUS model's drivers,
fitted them, and stored the result as the model that had just been chosen: the
band said one model, the store held another's severity half, and the bar read
"edited since opened" though nothing had been edited. The re-estimate now waits
until the local copy and the store agree.

## A projection could wedge, and locked its own escape

No request carried a timeout, so a fetch that stalled — a dev-server module
swap mid-flight, a dropped connection — left its promise pending forever and
the mutation waiting on it stayed "in progress". The Re-project button was
disabled while pending, so a wedged projection could only be cleared by
reloading the page.

Every projection and fit now goes through a POST helper with a hard 45-second
timeout: the worst case is an error with a retry, never an endless spinner. And
the Re-project button is always clickable — it resets a pending run and starts
a clean one — so a stall is one click from recovery.

## Equations are typeset

The methodology captions carried equations as plain text — `E[LGD] =
sigmoid(X·β)` — which read as code. They are now rendered with KaTeX:
𝔼[LGD | X] = σ(Xβ) in real mathematical script, inline in the caption at the
caption's size and colour. KaTeX is self-hosted from node_modules, fonts and
all, so it renders offline. `Eq` takes a TeX string and an optional display
flag.

## The brand lockup

The header set "Credit" in ink and "IQ" in accent blue. A two-tone name is the
reliable tell of a small-shop product; the references this sits beside —
Capital IQ, Aladdin, the KPMG mark itself — set the name in one colour and let
the type carry it. The name is now a single ink, in the adopted serif, with
KPMG keeping its own blue so the two marks stay two marks.

What makes it read as a product rather than a word is the line beneath it:
CREDIT RISK MODEL DEVELOPMENT in tracked capitals, quiet, aligned under the
name. The client attribution speaks in the same voice — PREPARED FOR over the
client's name — so the header is one set piece in two text styles rather than
three unrelated ones. The rule between the marks spans the full two-line block.
The hero treatment for a title slide is the same system at display size.

## The brand page returns, as a chooser

Deleted earlier as a specimen sheet on a live route; rebuilt as a working
direction-chooser, reachable from the command palette only. Five lockup
structures render inside mocks of the real header, at the real size, with the
real KPMG artwork — a specimen at display sizes fools everyone. Clicking one
adopts it and the actual header changes at the same moment, so a candidate is
judged live in the chrome it has to work in. The choice persists.

Alongside the structures: three product-mark ideas, each shown at slide,
header and favicon size, because the only real test of a mark is 16 pixels;
and the title-slide treatment on the navy field and on paper. Every direction
keeps the two marks separate — what varies is hierarchy, which is the only
axis worth having options on.

## The bright row separators in dark mode

Twenty-two row borders were written as `border-hairline/40` and variants. The
hairline colour is a CSS variable, Tailwind cannot compose slash-opacity onto a
variable, so those classes were never generated at all — and the borders fell
back to the framework's default light grey, which is near-invisible on paper
and glaring on the dark surface. The tables and lists looked under-lined in
light mode and over-lined in dark, from the same missing class.

All of them now use the plain hairline token, and the DEFAULT border colour is
set to that token too, so a border class that fails to resolve in future falls
back to an invisible line rather than a bright one.

## Switching challengers reads from cache; nothing re-estimates

Switching among saved models re-fitted the severity model and re-projected the
scenarios on every switch, both ways. The PD side did not, and the difference
was structural: the PD fit was a query keyed on the model's hash, served from
cache; the severity fit and the projection were mutations driven by effects —
an auto-run effect with a dedup ref, a manual result state cleared by hand, a
hold timer, and a reset escape for when the pending flag wedged. Every piece of
that machinery re-implemented, by hand and with bugs, what a cache-keyed query
does by construction.

Both are queries now, keyed on the model's identity. Switching to a model
fetches once; switching back serves its numbers instantly from cache with no
request. Comparing challengers, which is exactly that switch, costs nothing
after the first look at each. The explicit buttons remain the escape hatch:
Refit fits an edited draft and seeds the cache under its new hash, and
Re-project forces a fresh computation past every cache. One behaviour change:
the scenarios stage now projects any complete model on arrival rather than
waiting for the button, because the projection is the page's content, not an
action on it.

## Saving got an exit, and drift got one too

Saving a model left the workspace insisting it was still unsaved: the save
never told the state machine that the model on screen had become the version
just written, so the call to action stayed "Save this model" after every save.
Fixing that exposed a second gap in the same place — the fit record's hash was
computed with the severity half as it stood at PD fit time, while the saved
hash carries the severity half as saved, and the mismatch read a freshly saved
model as drifted. The save now settles both: the loaded record points at the
new version, and the fit record is brought onto the saved identity.

Drift itself — a saved model whose refit no longer reproduces its recorded
hash, which happens when the data or the engine changed under it — had a call
to action that could not exit: "Refit and compare". Drift only ever appears
AFTER the divergent refit has run, so refitting again reproduces the same
divergence forever. The drifted state now says what happened ("refit no longer
matches the record") and routes to the way out: save what the data now
produces as a new version, or close the record. The store de-duplicates the
save if that identity is already on file.

## The call to action acts when it is already there

The model bar's call to action navigates to the stage that needs work. Clicked
while already on that stage, it navigated to the page it was on — nothing
visible happened, and a button named "Fit the PD model" that does nothing
reads as broken. On the target stage the button now runs the stage's primary
action: the fit on the model panes, the default save on Versions. Off the
stage it navigates, as before, and the arrival does not auto-run anything.

## A forked draft is not its parent

After forking a saved model, the band's headline kept the parent's name and
hash — the fitted identity still described the previous specification — while
the bar above said "Working draft". The two disagreed about what was on
screen. Until a refit gives the draft an identity of its own, the band now
says "Working draft · the specification changed · a refit gives it a Model
ID", and the stale name is withheld.

## Severe-scenario sensitivity: the LGD generator was the outlier

Severely adverse ECL ran 6-8x baseline on mortgage and 8-10x on commercial
real estate, which read as irrational. The diagnosis, by decomposing the
projection year by year: the PD response was inside the data's own evidence
(the severe path's peak marginal default rates sat at or below the panel's
2009 peak), but portfolio LGD reached 49% on mortgage and 61% on CRE in the
trough year, against realised GFC averages near 40% and 45%. The generator's
severity-side macro slope was roughly twice what the asset classes produced,
and it stacked with the LTV-at-default channel, which carries the same price
fall.

Both severity slopes were halved and the LTV channel trimmed with them.
Baseline severities are unchanged, because the slopes are centred on benign
values. The result: severe/base ECL is now 2.1x consumer, 4.3x mortgage,
6.3x CRE, with trough-year LGD at 32% and 47% — the ordering and rough
magnitudes CCAR results show for these asset classes. The remaining ratio is
PD-driven, which is the panel's own crisis and is evidence, not artifact.
Saved versions from the previous panel carry the stale-data flag.

## The navigation is a sequence, not six tabs

Knowing where you are in the process was the hardest part of the workspace.
The six surfaces already sit in the order the work happens, so the navigation
now says so: each stage carries its number (which is also its keyboard
shortcut), the hairline between two stages fills with the accent once the
earlier one is complete, and the stage the call to action points at carries
an accent ring on its dot. No new chrome row; the sequence rides on the
navigation that existed.

## Parity and context in the specification tables

The LGD coefficients table now matches the PD card: every term that is a
driver on the book is a click-through to its severity curve and binning. Both
tables state the reference bin of every dummy-encoded term ("vs office"),
because an indicator coefficient is a shift relative to the bin that has no
column, and without the reference it reads as an absolute effect. The fit
responses carry a `references` map for this.

## Macro candidates: quick pick and a wider transform grid

The macro section of both candidate lists has an "Add top 3" action: the
strongest remaining terms by correlation, one per underlying series (several
transforms of one variable are one piece of information, not three), skipping
terms that contradict the economic prior, applied as ONE guarded edit so a
saved model prompts to fork once. The transform grid gains moving averages
(3, 6, 12 month), smoothed growth (12m change averaged over 3m) and smoothed
momentum (1m change averaged over 3m); every one goes through the same
apply_mev_transform the projection uses, so a scenario carries them forward
correctly by construction.

## Fitted results persist to disk

"Have I run this model before?" answered differently depending on whether the
server process had restarted: the fit, severity and projection caches were
memory-only, so a previously fitted specification came back as a fresh
twenty-second refit, which reads on screen as "never run". Computed results
are now also written to `data/cache/` (pickles of the derived objects), and
the memory caches fall back there before recomputing. After a restart, a
previously fitted specification returns in under a second and a previously
run projection immediately; the roll-up inherits this through the same
service. Two rules keep the cache honest: keys carry the portfolio's data
fingerprint, so a rebuilt panel invalidates every cached run fitted on the
old one, and entries are bounded per portfolio, oldest out first (a PD run
carries its scored panel for re-cohorting, roughly 36MB). The cache is fully
derived — deleting it costs recomputation, nothing else — and is gitignored.

## The LGD table flags insignificance the way the PD card does

The PD specification card carried a "not significant" pill per term; the LGD
coefficients table showed only p-values and stars. Same information, one side
shouted and the other whispered. The LGD table now carries the same pill,
with one note in place: for an indicator, "not significant" means that level
is not distinguishable from the reference — grounds to merge bins, not
necessarily to drop the variable.

## First open is a welcome, not a computation

With no saved versions, the roll-up landing used to fit three books'
documented default specifications on arrival: a new user's first experience
was minutes of computation ending in a loss number they had no hand in. The
landing now checks whether anything has ever been saved. With nothing saved
it shows a single welcome screen: what the platform is, the three books as
starting points, and the six-stage workflow in the order the navigation
presents it. It is one screen rather than a step-by-step tour, because the
navigation stays fully usable behind it, so it is skippable by construction;
a skip link runs the roll-up on the documented defaults for whoever wants a
number immediately, with the compute cost stated. The welcome disappears for
good the moment the first version is saved. The test-session versions were
archived to versions/archive-2026-08-31 rather than deleted.

## The scenario editor became a statement of what was stressed

The scenario stage carried an editor for dragging custom macro paths. What a
reader of a projection needs is the opposite of an input: a statement of what
was USED. The editor is gone, and in its place the stage shows each macro
term of the fitted specification exactly as the projection consumes it —
transformed and lagged, history to the projection date, then the Federal
Reserve baseline and severely adverse branches, drawn as small multiples
with one shared grammar (history in muted ink, the same light-to-dark ramp
the ECL charts use). Under each chart the break-off is stated as figures:
now, baseline end, severe extreme. A new endpoint
(/api/scenarios/model-paths) serves the branches through the same
apply_mev_transform the projection itself uses, so the display cannot drift
from the computation. The custom-path plumbing was removed with the editor.

The roll-up gained the same panel per book — "What each model responds to" —
grouped under each portfolio with its model's name, so the executive view
states which macro exposures each book's number rides on.

## Expected loss in two shapes

The cumulative loss charts (scenario stage and roll-up) gained a
Cumulative / Monthly toggle. The cumulative curve answers "how much"; the
monthly flow answers "when" — under stress it separates from the baseline as
losses emerge, then contracts back as the stressed cohorts resolve, which
the cumulative view cannot show. The roll-up derives the flow as the first
difference of the reported running total.

## The macro-paths panel earned its polish, and the duplicate tab went

The first cut of the paths panel titled each chart with its mono slug
("unemployment_rate · level"), hung PNG/SVG chips under every mini chart, and
had no legend — a grid of six charts with six ragged chip rows read as
uneven, and an identifier is not a title. Now: the variable's published name
over each chart with its transform in words beneath ("Prime rate" over
"12-month change · lagged 12 months" — the slug stays on hover), ONE legend
on the card head where it also balances the caption, no per-chart chips (a
`compact` mode on the chart component, for any future small multiple), and a
uniform Now / Baseline / Severe figures row under every chart so the grid
reads as one table. A derived series such as cre_price_index_yoy resolves
its title through its base registry entry.

The scenario stage's "Macro variables" tab was removed: it duplicated the
Macro stage, and the paths panel answers the question this page actually
asks — not "what could a model use" but "what did this one use". On the
roll-up, the panel moved below the loss charts so the page reads number →
composition → timing → drivers → concentration, with each book's model name
set right of its heading.

## The roll-up became a dashboard, not a stack of cards

Three structural fixes, one new control:

The coverage/selector card is gone. Its sentence ("2 of 3 books on a fitted
model") folded into the hero as a strip under the figures, and each book's
model picker moved INTO its position card — the knob now lives on the object
it changes. The position cards pin their pickers to the bottom edge so the
three align whatever each card carries above them, and the sign-flip and
stale-data flags moved onto the cards as pills beside the extrapolation one.

The macro-exposure card flattened. One row of small multiples per book left
two-thirds of most rows empty; the terms are now a single deduplicated grid
(auto-fit columns, so it fills whatever width it has), and a term carried by
more than one book renders ONCE with each book's dot — the honest reading,
since a shared series is one exposure however many models load on it, and a
common factor across books is exactly what a committee wants stated.

The hero gained the page's one legitimate knob: a probability-weight slider
on the weighted ECL. The weight is a management assumption, not a
supervisory number, and the weighted figure is linear in the two scenario
ECLs, so it recomputes instantly client-side as the slider moves.

## Data generation moved into the app; cache warm-up became opt-in

Two boot problems, one machine: the repository ships no panels (they are
generated), so a fresh clone failed on empty endpoints until `make setup`
had built them — and once they existed, a startup hook eagerly loaded and
profiled all three books, roughly 9 GB, which on a smaller laptop swapped
the machine and left the frontend on its loading skeletons. The app looked
broken on exactly the machine it had just been handed to.

Now the app boots instantly in either state. With no panels, every surface
is gated behind an initialize screen: one button, and generation reports 29
tracked steps (the simulation loop ticks once per three simulated years, so
the long steps move too) with a step counter, elapsed time and a rough
remaining estimate — a person waiting three minutes deserves to know it is
three minutes. Polling continues in a background tab, and completion
reloads the app rather than invalidating hundreds of queries. The warm-up
is opt-in: `make dev` is lazy (first click per surface computes once, then
the disk cache holds it, across restarts), `make demo` sets CREDITIQ_WARM=1
for instant first clicks when the memory is there. docs/HANDOFF.md now
carries the new-machine instructions, including this trade.

## The roll-up's second aesthetic pass: a matrix, a dumbbell, an honest bar

The probability-weight slider left the hero: a knob nobody asked to turn was
costing headline space.

"What the models respond to" became a matrix — one row per macro term
crossing three fixed book columns, a filled dot where the book's model
carries the term and a faint ring where it does not. The grid layout it
replaced was tuned for four terms and fell apart at one; rows are the same
shape at any count, the path gets the full row width, and the break-off
lands in aligned Now/Baseline/Severe columns, so the card reads as one
table. Membership stopped being a six-pixel hint and became the structure.

Concentration earned its legend: each book's cut is now named (origination
FICO, current LTV, property type), the bar is the band's share in the
book's own colour — the old sequential ramp encoded the same number as the
bar length, which is a decoration pretending to be a channel — and share
and balance both print. The three books sit side by side full-width.

One addition: "Risk parameters under stress" — 12-month PD and LGD per
book as dumbbells from baseline to severely adverse, in the same two
scenario colours every chart uses. It states, in one glance, which half of
which book's loss number the stress actually moves; the data was already in
the payload.

## One data identity, checked at every read

"Sometimes an old LGD fit appears at random" was not random. Every cache in
the process — fitted PD runs, severity models, projections, screenings, the
macro library, the roll-up — was keyed on the SPECIFICATION alone, and only
one of them was registered to clear when the panels changed. Rebuild the
data under a running server (`make data` in a second terminal, or the
in-app generate button) and every layer kept answering from the dataset
that no longer existed until someone restarted the process by hand.

The store now stamps the build report's mtime and checks it — one stat
call, microseconds — at the top of every public read. On a change it drops
its own frames and every registered dependent in one move, and every
derived cache is now registered: the fit service, the severity and
projection caches, the screening and health profiles, the macro library,
the roll-up. The disk cache was already fingerprint-keyed and needed
nothing.

The frontend gets the same discipline through one number: /api/health now
carries a combined data fingerprint, the shell polls it every twenty
seconds (in background tabs too — a rebuild happens in a terminal precisely
while the tab is not being looked at), and a change reloads the app, the
same clean transition the initialize flow uses. And the severity pane's
stored metrics now always follow the fit on screen; the old guard only
refreshed them when they were missing, so numbers recorded against a
previous panel survived into the band. Two regression tests hold the
mechanism: a touched build report fires every dependent exactly once, and
the model-service caches must be on the dependent list.

## The scenario page's macro paths joined the row table

The scenario stage still showed its macro paths as a grid of tiles, which
was tuned for three-across: two terms left a hole, one term rattled in a
wide card. It now uses the same row-per-term table the roll-up uses,
without the book columns — the scenario page shows one model, so
membership is not a question there. Each path gets the full card width
(over 1000px against the tile's ~300), the figures land in aligned
columns, and the exhibit is the same shape at any term count. The tile
grid had no remaining callers and was deleted.

## No silent substitutes, anywhere in the analyst flow

Two fallbacks produced numbers the analyst never asked for. The scenario
stage projected with the documented default severity specification when
none was fitted — behind a banner, which is a confession, not a fix — and
its fallback chain could even resurrect an LGD spec embedded in an old PD
fit request. And the LGD workbench auto-fitted the proposed default
specification the first time a virgin book was visited, so a severity
model existed that nobody chose, which everything downstream then treated
as the analyst's model. Together these were the "old fit out of nowhere"
experience.

The rule now: nothing in the analyst flow substitutes a default. Scenarios
requires both halves fitted — otherwise a full empty state names what is
missing and carries the one action that fixes it, and no request is made.
The LGD workbench presents its starting drivers as a visible, pre-selected
PROPOSAL; becoming a model requires the click that makes it a decision.
The one place documented defaults remain is the roll-up, where they exist
to keep the executive total covering every book — and every use is
labelled on the card that shows it.

## The extrapolation note follows its materiality

The "scenario leaves the estimation window" card rendered in amber however
small the effect, and a warning box over a 1.8% difference teaches readers
to ignore warning boxes — the user's reaction was "I don't get the point
of this note". The point is real (the model answering beyond its fitted
range is the first thing a validator checks), so the note stays; its
weight now follows its size. Under a 2% effect on severely adverse ECL it
is one quiet line stating that the path was checked and almost none of the
number rests on extrapolation — a finding of safety. The amber card is
reserved for a material share, and its title now says what it means in
plain words: part of this scenario is beyond the model's experience.

## The skeletons mostly died: expensive reads joined the disk layer

The PD workbench's full-page skeleton was the variable screening being
recomputed — eleven seconds on the mortgage book — on the first visit after
every server restart, and the development loop restarts the server on every
code edit. The Data surface's profile (7.6s) and the macro library had the
same disease. All three are per-portfolio, derived, read-only computations,
so they now stack a disk layer under their memory cache through one
decorator (`runcache.disk_through`): memory answers first, disk answers
across restarts, a miss on both computes and saves. Measured across a
restart: screening 11.1s to 0.0s, profile 7.6s to 0.0s.

On the frontend, the query cache holds results for an hour instead of five
minutes — leaving a surface for six minutes and returning showed the
skeleton for data that could not have changed. Both moves are safe for the
same reason: the data-fingerprint watchdog reloads the app when the data
actually changes, and the disk keys carry the fingerprint.

The one tradeoff, inherited from the fitted-run cache and now stated in
the decorator's docstring: the key is the DATA's identity, so a change to
the computation's own code serves the old result until the data is rebuilt
or data/cache/ is deleted (`make reset` does both). Acceptable in a
repository whose analytics are stable; the person it can surprise is the
developer editing the screening logic itself, who knows where the cache
lives.

## Switching tabs no longer refits — mounted is not opened

With a saved version open, every visit to the PD stage re-ran the "a
version was opened" hydration effect — an effect's dependency array does
not stop its first render, and a tab switch IS a fresh first render. The
hydration's setResult(null) deleted the cached fit each time; the query
refetched, and when the fit was in no cache the auto-replay fired a full
estimation. Felt as: "it refits every time I switch between PD and LGD."

The guard is a module-scoped record of which version each book has
hydrated this session — module scope, not a ref, because a ref dies with
the unmount that a tab switch is. Measured after the fix: two full
PD-LGD-PD-LGD round trips produce zero API calls beyond the health ping.

## Session-over-session smoothness comes from the server's disk, on purpose

The requirement: fit only the first time and when the specification
changes — across page reloads and browser restarts too. This already
holds, and the durable layer is deliberately the SERVER's fingerprint-keyed
disk cache rather than a persisted browser cache. Measured on a fresh
session with a version open: every request the first paint needs is
answered inside 210ms of navigation, zero fit POSTs fire, and nothing
recomputes.

One race made it look otherwise and is fixed: the auto-replay used to fire
while the lookup for the already-computed fit was still in flight, POSTing
a fit the cache was about to answer. It now waits for the lookup to come
back empty before estimating anything.

Persisting the query cache in the browser was considered and declined:
localStorage quotas against multi-megabyte fit payloads, a second
invalidation surface duplicating what the data fingerprint already does,
and stale-flash on reload — real failure modes purchased for
milliseconds. One durable cache, server-side, one identity. At deploy
time that layer moves behind auth with the rest of the state, unchanged
in design.

## The roll-up's documented defaults are gone too

The one surviving default — the roll-up projecting an unpromoted book on a
documented default specification, labelled — still read as a ghost: a
number the user never made, on the page that matters most. The rule now
has no exceptions. A book with no promoted (or explicitly selected) model
contributes NOTHING: its position card is a prompt carrying its exposure,
its account count and the fix (build a model, or report it on a saved
version through the picker); the hero says "Totals cover N of M books";
and every model-derived exhibit covers only reported books. Concentration
stays for all books, because it is a property of the data, not of any
model. With versions saved but no champion anywhere, the whole page is
the prompt. The welcome screen's "skip and run on documented defaults"
escape went with it.

The browser-side candidate caches were wiped by a store version bump
(v4): every browser that opens the app drops its fitted records, drafts
and specs once, keeping preferences. Saved versions live on the server
and are untouched.
