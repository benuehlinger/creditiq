# CreditIQ

Credit risk model development platform. A KPMG demonstration asset.

**All data in this application is synthetic and labelled as such on every
data-bearing view. It is not any institution's portfolio. Nothing here asserts
regulatory approval, model validation, or SR 11-7 compliance.**

## Run it

```
make setup     # one time: venv, dependencies, npm install
make dev       # backend + frontend, opens the browser
```

Or `docker compose up`.

The application runs **fully offline with zero configuration**. Macroeconomic
history is a committed FRED snapshot and the supervisory scenarios are committed
CSV files, so no API key and no network access is required. The FRED key input
exists only to demonstrate a live refresh.

## The six stages

| Stage | What it does |
|---|---|
| **Data** | Load, profile and validate a loan-level panel; panel-integrity checks |
| **Macro** | The supervisory variable catalog and the transformation search (lags, differences, moving averages), ranked against both targets |
| **PD model** | The workbench: candidates with WoE/IV, the rebinning editor, correlation and VIF, the fit, diagnostics and the backtest by performance date |
| **LGD model** | The same workbench on realised severity: drivers, the fractional-logit fit, calibration and backtest |
| **Scenarios** | ECL under the Federal Reserve scenarios, the attribution bridge, the macro paths the projection consumes, IFRS 9 staging |
| **Versions** | Save, name, compare, promote, lineage |

Plus **Portfolio Roll-Up**, the consolidated executive view: the stressed
loss position across all books, the probability-weighting control, loss
composition and emergence, the macro exposure grid, sensitivity and
concentration.

## Commands

```
make data      # regenerate every synthetic panel, deterministically
make fred      # refresh the committed FRED cache (needs network; the app does not)
make test      # backend test suite
make reset     # clean demo state, safe between back-to-back demos
```

## Documents

- [`METHODOLOGY.md`](METHODOLOGY.md) — every formula and assumption
- [`DECISIONS.md`](DECISIONS.md) — every choice, and every reversal, with reasons
- [`GENERATIVE_TRUTH.md`](GENERATIVE_TRUTH.md) — the coefficients that produced the data
- [`DEMO_SCRIPT.md`](DEMO_SCRIPT.md) — a 12-minute walkthrough with click paths
- `data/synthetic/*_dictionary.md` — a data dictionary per portfolio
