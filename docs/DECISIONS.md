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
Helios **derives** an adverse path as a 50% severity interpolation between the two
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

**Calibration is automated, not hand-tuned.** `helios.data.calibrate` bisects the
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
