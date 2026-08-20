# Helios — Implementation Plan

KPMG credit risk model development platform. Demo asset for Apollo FIG.
Repo root: `/Users/benuehlinger/helios`. Change this location if you prefer a different path.

---

## 0. Status of this document

I read the `dataviz` skill first, as instructed. I then completed the color work,
because color is a hard input to every surface and it is computable. Section 3
gives validated results, not intentions. The remainder of this document is the
build plan. Section 12 lists the decisions I need from you.

---

## 1. Toolchain — verified on this machine

| Item | Found | Decision |
|---|---|---|
| Python | 3.14.6 default, 3.12.0 present, `uv` present | Pin **3.12** through `uv`. `optbinning` and `statsmodels` do not have complete wheel coverage on 3.14. |
| Node | v23.11.0, npm 10.9.2 | Use as found. Vite 6 + React 18. |
| Docker | **not installed** | I will write `Dockerfile` + `docker-compose.yml` and lint them. I cannot execute them here. See Risk R1. |
| FRED | no key present | Ship the committed cache. The key input is optional. |

`make dev` starts the backend and the frontend together and opens the browser.
`make data` regenerates all synthetic panels. `make test` runs both test suites.

---

## 2. Repo layout

```
backend/    FastAPI app · modeling engine · data generators · tests
frontend/   React 18 + TypeScript + Vite + Tailwind + ECharts
data/       synthetic/ · mev_cache/ · scenarios/
versions/   saved model configs (JSON)
docs/       METHODOLOGY.md · DECISIONS.md · DEMO_SCRIPT.md · GENERATIVE_TRUTH.md
```

---

## 3. Design foundation — COMPLETE and validated

### 3.1 Brand hex verification

I verified the KPMG hexes against public brand references. Deep blue `#00338D`,
medium blue `#005EB8`, light blue `#0091DA`, violet `#483698` and green `#00A3A1`
are all confirmed. Pink `#910048` appears in third-party brand references, but the
KPMG secondary set that I found lists purple `#470A68` and light purple `#6D2077`
beside the violet. I keep `#910048` and record the ambiguity in DECISIONS.md.

### 3.2 The raw brand palette FAILS the dataviz gates

I ran the validator on the six brand hexes as a categorical palette:

```
[FAIL] Lightness band       #00338D L=0.359 · #483698 L=0.412 · #910048 L=0.424
[FAIL] Normal-vision floor  #005EB8 <-> #00338D  ΔE 13.2  (floor is 15)
```

This result is correct and expected. `#00338D`, `#005EB8` and `#0091DA` are three
steps of **one** blue ramp. They are not three identities. A brand ramp is not a
categorical palette. I therefore split the brand into two jobs:

- **Blue is the structural spine** — chrome, sequential magnitude, ordinal ramps.
- **A snapped 5-slot set carries identity.**

### 3.3 The categorical palette — all checks PASS in both modes

I held each brand hue angle, moved lightness only, enumerated slot orders, and kept
only orders that clear every gate. I then chose the passing set with the smallest
lightness drift from the brand hexes.

| Slot | Hue | Light | Dark |
|---|---|---|---|
| 1 | blue | `#005eb8` | `#0061be` |
| 2 | teal | `#00a19f` | `#00a4a2` |
| 3 | magenta | `#940049` | `#bf0061` |
| 4 | sky | `#0091db` | `#0091db` |
| 5 | violet | `#5200ce` | `#6c2cff` |

Slot 1 light is the exact KPMG medium blue. Slot 4 is the KPMG light blue. Slot 2
is within one step of the KPMG green. Violet and magenta move up in lightness only,
because the brand values sit below the band floor.

```
CATEGORICAL light  (surface #FCFCFB) → ALL CHECKS PASS   worst adjacent CVD ΔE 18.3 · normal ΔE 21.0
CATEGORICAL dark   (surface #0F1216) → ALL CHECKS PASS   worst adjacent CVD ΔE 12.7 · normal ΔE 21.1
SLOTS 1-3 --pairs all, light         → ALL CHECKS PASS   CVD ΔE 18.9 · normal ΔE 21.0
SLOTS 1-3 --pairs all, dark          → ALL CHECKS PASS   CVD ΔE 12.7 · normal ΔE 21.1
```

The slots 1-3 all-pairs run matters. The three portfolios appear together in
scatter and small-multiple forms on the roll-up view. Those forms need the harder
all-pairs gate. Slots 1-3 clear it, so **Consumer = slot 1, Mortgage = slot 2,
CRE = slot 3**. The series cap is 5 on adjacent forms and 3 on all-pairs forms.
Past the cap I fold to "Other", facet, or use emphasis.

### 3.4 The ordinal ramp — one KPMG blue hue, PASS in both modes

```
light  #73b1ff #479aff #0083fb #0070d8 #005db6 #004b96 #003a76   → ALL CHECKS PASS
dark   #004991 #005ab1 #006dd3 #0080f6 #3f97ff #6dadff #94c3ff   → ALL CHECKS PASS
```

Both clear monotone lightness, adjacent ΔL ≥ 0.06, the 2:1 surface-end floor and
the single-hue check.

### 3.5 Surfaces, ink and status

Dark chart surface `#0F1216`. Light chart surface `#FCFCFB`. Status keeps the
reference scale, because status must never impersonate a series:
good `#0ca30c`, warning `#fab219`, serious `#ec835a`, critical `#d03b3b`.
On the light surface warning (1.79:1) and serious (2.57:1) sit below 3:1 by design.
The icon and the label carry the meaning there. Status never appears alone.

### 3.6 Encoding map — the color job for every chart

This is the part that keeps the app coherent. Color follows the data's job.

| Surface | Chart | Form | Color job |
|---|---|---|---|
| Explore | WoE by bin | diverging bar on zero | **diverging** blue ↔ magenta, gray midpoint |
| Explore | Bad rate by bin | column + confidence band | 1 hue (slot 1) |
| Explore | IV ranking | horizontal bar | 1 hue + **status** on the leakage flag |
| Explore | Correlation matrix | clustered heatmap | **diverging** blue ↔ magenta on ρ |
| Explore | PSI over time | line | 1 hue + status threshold rule |
| Explore | Distribution | histogram | 1 hue |
| Model | ROC / KS / calibration | line + reference | 1 hue + muted reference |
| Model | Lift and gains by decile | column | **ordinal** ramp |
| Model | Actual vs predicted by date | 2 lines | 2 categorical slots, direct-labeled |
| Model | AUC by cohort | line | 1 hue |
| Model | Vintage curves | multi-line | **ordinal** ramp — vintage is ordered |
| Model | Segment backtest | table + emphasis | gray + 1 accent on the failing segment |
| Scenarios | MEV history + forward | line, split at the seam | 1 hue, solid actual / distinct projected |
| Scenarios | Scenario comparison | 3 lines | **ordinal** ramp — severity is ordered |
| Scenarios | ECL attribution bridge | waterfall | **status** — increase = risk, decrease = relief, neutral totals |
| Roll-up | ECL by portfolio | stacked bar | categorical slots 1-3 |
| Roll-up | Sensitivity tornado | diverging bar | **diverging** |
| Roll-up | Concentration | heatmap | **sequential** one hue |
| Roll-up | Headline ECL | **hero figure** | not a chart |

Note two deliberate calls. Scenario severity is **ordinal**, not categorical,
because baseline → adverse → severely adverse is an order. Vintage is ordinal for
the same reason. Both choices avoid an eleven-hue chart.

### 3.7 Chart rules I will apply everywhere

Per the skill: no dual-axis chart anywhere; a legend for two or more series;
selective direct labels only; 2px lines; ≤24px bars with a 4px rounded data end;
a 2px surface gap between touching fills; hairline solid grid; crosshair and
tooltip on line and area; per-mark tooltip on bar, cell and dot; a 24px minimum
hit target; a table-view twin on every chart; text in ink tokens, never in the
series color. Dark mode is a selected set, not a flip. On refetch the charts hold
the previous render at reduced opacity.

---

## 4. Synthetic data — build step 1

I will generate through the monthly discrete-time hazard process, exactly as
specified. No rule-based default flag.

1. Draw correlated static attributes through a **Gaussian copula**, so FICO, DTI,
   income and LTV correlate realistically.
2. Draw an account-level **frailty** term `u_i`. This term keeps AUC in the
   0.72-0.82 band and stops the data from being fully explainable.
3. Build the account-month hazard:
   `logit(h_it) = α(age_it) + β'x_i + γ'z_t + δ'(x_i ⊗ z_t) + u_i`
   `z_t` are the **real FRED paths** from the committed cache.
4. Draw default, prepayment and maturity as competing risks. Stop at the first
   terminal event.
5. Calibrate β, γ and δ until realized rates land in the target bands and 2020
   shows a visible spike.

Targets: consumer 3-6% annualized, mortgage 0.5-2%, CRE 1-3%. Office diverges
after 2022 through a CRE-index interaction on property type.

Planted imperfections, all required for the demo to have something to catch:
missing patterns including one column near 30%, outliers and one impossible value,
inconsistent categorical coding, 2-3 noise variables at IV < 0.02, one near-leakage
variable at IV > 0.8, one correlated pair above 0.95.

Deliverables: deterministic under a fixed seed, parquet plus a CSV sample, a data
dictionary per portfolio, and `docs/GENERATIVE_TRUTH.md` with the true coefficients.

---

## 5. Models

**PD.** Discrete-time hazard, panel logistic on account-months. WoE-binned or
raw/splined per variable, at the user's choice. Report coefficient, SE, z, p, VIF
and WoE-scaled contribution. Estimators: logistic (champion), L1/L2 regularized,
gradient boosting as a **challenger only**, to quantify the interpretability cost.
Seasoning spline on months-on-book plus vintage effects. MEV terms enter here.
Scorecard at PDO 20, base 600 at 50:1.

**LGD.** Two-stage zero-inflated fractional model. `P(loss > 0)` through logit,
then `E[loss | loss > 0]` through a fractional logit or beta regression. Drivers
include collateral position at default, macro at default, workout duration and
guarantor. LGD **must** move with the scenario.

**EAD — per asset class, never one model.** I follow Section 5.3 exactly.
Amortizing products use the deterministic contractual paydown schedule with an
optional CPR/SMM haircut. Revolving facilities use CCF/LEQ, estimated with the
fixed-horizon 12-month cohort method, with a fixed-CCF fallback toggle. The UI
shows an EAD Method selector per portfolio and states the assumption in plain
English on the specification card.

**ECL.** `ECL_i = Σ_t MPD_i(t) × LGD_i(t) × EAD_i(t) × DF(t)` with the
survival-adjusted marginal PD `MPD_i(t) = PD_i(t) × Π_{s<t}(1 − PD_i(s))`.
CECL lifetime is primary. IFRS 9 staging is a secondary toggle. The attribution
bridge decomposes baseline → PD → LGD → EAD → mix/seasoning → stressed, and it
must reconcile to the total.

---

## 6. MEV and frequency reconciliation

I will verify all 16 FRED series IDs at build time and log any failure. I will not
drop a variable silently. The CRE price index has no clean FRED equivalent; I will
pick the closest series and record the choice in DECISIONS.md.

The canonical grain is monthly. Every MEV carries metadata: native frequency,
stock or flow, level/rate/index/growth, and the aggregation rule. All conversion
reads that metadata. There is no global rule.

Quarterly to monthly uses **Denton-Cholette proportional benchmarking**, or
Chow-Lin where a monthly indicator series exists. The monthly series must aggregate
back **exactly** to the published quarterly value. A test asserts this identity.

I never interpolate a growth rate. For growth variables I convert to a level index,
benchmark the level, then re-difference. The historical and forward paths join with
a level shift, and every MEV chart marks the splice point with a vertical rule and
a distinct projected line style. The reconciliation panel shows the raw quarterly
points over the derived monthly series with the residual.

Transformations: log-difference, YoY, QoQ annualized, 4-quarter change, level,
z-score. Lags 0-24 months. The lag/transform search ranks candidates and enforces
an optional hard economic-sign constraint.

---

## 7. Build order — vertical slices, demoable at every commit

| # | Slice | Demoable result |
|---|---|---|
| 1 | Generators + FRED cache + tests | Three panels exist. Tests pass. Relationships are real. |
| 2 | FastAPI + React shell + portfolio routing + design system | The app runs. The switcher works. Charts use the validated tokens. |
| 3 | Data surface | Load, profile, validate, clean through a replayable recipe. |
| 4 | Explore surface | WoE/IV, binning editor, correlation, selection tray. |
| 5 | Model surface | PD fit, diagnostics, backtest by performance date. |
| 6 | MEV surface | FRED, reconciliation, CCAR splice. |
| 7 | Scenario + LGD + EAD + ECL + bridge | The stress number moves. |
| 8 | Versioning | Save, auto-name, compare, lineage. |
| 9 | Roll-up executive view | The CRO screen. |
| 10 | Polish, exports, docs, demo script | Ready for the room. |

I will never leave the app in a non-running state. If scope must be cut, I cut
from step 10 backward.

---

## 8. Performance

The target is a full refit and backtest in under about 2 seconds. The plan:
vectorized numpy on account-month arrays, warm-start coefficients, a result cache
keyed on the config hash, and a fit-sample downsample toggle. The downsample toggle
is **visible in the UI and honest about what it does**, per Section 12 of the brief.
If a fit will be slow, the UI shows real progress, never a frozen screen.

---

## 9. Tests — mapped to the Definition of Done

| Test | Asserts |
|---|---|
| Data invariants | No rows after a terminal event. No duplicate account-date keys. Balances are non-negative except the planted value. Rates land in the target bands. |
| Discrimination | Headline AUC is inside 0.72-0.82. |
| WoE/IV | Matches hand-computed cases. |
| Benchmarking identity | The monthly series aggregates back **exactly** to the published quarterly CCAR value. |
| ECL identity | The survival adjustment and the bridge reconcile to the total. |
| Config round-trip | Export, fresh import, identical metrics. |
| Guardrails | The leakage variable trips the flag. The noise variables screen out. |
| Palette | The committed tokens still pass `validate_palette.js`, in CI. |

---

## 10. Guardrails I will hold

Synthetic data carries a permanent marker on every data-bearing view. I will never
imply regulatory approval or SR 11-7 compliance. I will not fabricate Apollo FIG
figures or a logo; the header uses a typographic treatment. The FRED key stays in
memory, never on disk, never in a log, and `.gitignore` covers it.

---

## 11. Risks

- **R1 — Docker is not installed here.** I can author and lint the compose stack.
  I cannot prove `docker compose up` works on this machine. I will say so plainly
  rather than claim a green check.
- **R2 — `optbinning` wheels.** If it does not install cleanly on 3.12, I implement
  monotone ChiMerge or tree binning myself. I will not fall back to equal-width bins.
- **R3 — Coefficient calibration is iterative.** Hitting AUC 0.72-0.82 and three
  credible default bands at once takes tuning passes. Step 1 may take longer than
  it looks.
- **R4 — The 2-second refit budget** is the main performance risk on CRE lifetime
  ECL across a full scenario horizon. The cache and the downsample toggle are the
  mitigation.

---

## 12. Decisions I need from you

1. **Repo location.** I created `/Users/benuehlinger/helios`. Confirm or redirect.
2. **Palette sign-off.** Section 3.3 moves KPMG violet and magenta up in lightness,
   because the brand values fail the band. The blues stay exact. Tell me if brand
   fidelity must win over the accessibility gate; I will then ship the relief
   channel instead.
3. **Scope of the first build pass.** Steps 1-5 give you a real demo: data,
   explore, binning editor, PD model, backtest. Steps 6-9 add the stress story.
   Confirm you want the whole ten steps in one pass.

I will not deviate on the model math, the frequency-reconciliation contract, or the
EAD treatment without asking you first.
