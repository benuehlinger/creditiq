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
