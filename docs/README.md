# Helios

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

## The five surfaces

| Surface | What it does |
|---|---|
| **Data** | Load, profile and validate a loan-level panel; panel-integrity checks |
| **Explore** | Univariate, WoE/IV, the drag-to-rebin editor, correlation, VIF, the selection tray |
| **Model** | Fit PD, the specification card, diagnostics, backtesting by performance date |
| **Scenarios** | Macro catalog, frequency reconciliation, the splice, scenario editor, ECL and the attribution bridge |
| **Versions** | Save, name, compare, promote, lineage |

Plus **Portfolio Roll-Up**, the consolidated executive view.

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
