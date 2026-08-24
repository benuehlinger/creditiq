# Generative truth

Every coefficient that produced the synthetic data, so what CreditIQ recovers
can be checked against what actually generated it. This file is written
directly from `creditiq/data/portfolios.py` — it cannot drift from the code.

## How the data is made

For each account-month, the log-odds of rolling from current into
delinquency is

```
logit(h_it) = intercept + seasoning(age) + B'x_i + G'z_t + D'(x_i (x) z_t) + u_i
```

`z_t` is REAL macroeconomic history from FRED, not a simulated path. `u_i` is
an account-level frailty term standing for unobserved borrower quality; it is
what holds AUC in a credible band instead of near 1.0. Default is then
reached through a delinquency chain (30 -> 60 -> 90 ...), so the observed
default rate is an emergent property of the process, not a drawn quantity.

Prepayment and maturity compete with default. The account stops at the
first terminal event.

## Consumer installment (`consumer`)

- Accounts: 50,000
- Target: 90+ days past due or charge-off (delinquency state 3)
- Intercept: `-5.597` (calibrated to the realised default-rate band)
- Frailty standard deviation: `0.55`
- Seasoning (peak month, height, decay): `(14.0, 0.55, 0.045)`
- Delinquency chain: roll-forward `0.52`, cure base `0.3`

### Static driver coefficients (per standard deviation)

| Driver | Coefficient | Direction |
|---|---|---|
| `fico_orig` | -0.550 | reduces risk |
| `dti` | +0.180 | raises risk |
| `annual_income` | -0.080 | reduces risk |
| `employment_tenure_months` | -0.100 | reduces risk |
| `revolving_utilization` | +0.280 | raises risk |
| `num_trades` | -0.040 | reduces risk |
| `inquiries_6m` | +0.120 | raises risk |
| `prior_delinq_count` | +0.300 | raises risk |

### Categorical level effects

| Variable | Level | Coefficient |
|---|---|---|
| `loan_purpose` | debt_consolidation | +0.120 |
| `loan_purpose` | home_improvement | -0.080 |
| `loan_purpose` | major_purchase | +0.000 |
| `loan_purpose` | medical | +0.150 |
| `loan_purpose` | other | +0.050 |
| `channel` | direct | -0.050 |
| `channel` | partner | +0.000 |
| `channel` | broker | +0.140 |

### Macroeconomic coefficients (per standard deviation)

| MEV | Coefficient |
|---|---|
| `unemployment_rate` | +0.320 |
| `real_disp_income_growth` | -0.100 |

### Interactions — where the economics lives

**`revolving_utilization` x `unemployment_rate` = +0.140**

> A borrower already running high revolving utilization has no buffer left when unemployment rises, so their PD moves more.

**`fico_orig` x `unemployment_rate` = -0.120**

> Thin-file and low-FICO borrowers are hit harder by a labour market shock. The negative sign makes a LOW FICO raise sensitivity to a HIGH unemployment rate.

## Residential mortgage (`mortgage`)

- Accounts: 55,000
- Target: 180+ days past due or foreclosure referral (delinquency state 6)
- Intercept: `-6.114` (calibrated to the realised default-rate band)
- Frailty standard deviation: `0.8`
- Seasoning (peak month, height, decay): `(42.0, 0.5, 0.02)`
- Delinquency chain: roll-forward `0.66`, cure base `0.26`

### Static driver coefficients (per standard deviation)

| Driver | Coefficient | Direction |
|---|---|---|
| `current_ltv` | +0.384 | raises risk |
| `fico_orig` | -0.260 | reduces risk |
| `dti` | +0.099 | raises risk |
| `annual_income` | -0.037 | reduces risk |

### Categorical level effects

| Variable | Level | Coefficient |
|---|---|---|
| `msa` | Riverside, CA | +0.340 |
| `msa` | Cape Coral, FL | +0.310 |
| `msa` | Miami, FL | +0.220 |
| `msa` | Phoenix, AZ | +0.190 |
| `msa` | Detroit, MI | +0.260 |
| `msa` | Toledo, OH | +0.180 |
| `msa` | San Jose, CA | -0.240 |
| `msa` | Seattle, WA | -0.190 |
| `msa` | Raleigh, NC | -0.160 |
| `msa` | Austin, TX | -0.140 |
| `doc_type` | full | -0.060 |
| `doc_type` | alt | +0.180 |
| `doc_type` | low | +0.420 |
| `occupancy` | primary | -0.080 |
| `occupancy` | second | +0.120 |
| `occupancy` | investor | +0.340 |
| `product` | 30yr fixed | +0.000 |
| `product` | 15yr fixed | -0.220 |
| `product` | ARM 5/1 | +0.200 |
| `first_time_buyer` | Y | +0.100 |
| `first_time_buyer` | N | +0.000 |
| `property_type` | sfr | +0.000 |
| `property_type` | condo | +0.080 |
| `property_type` | townhouse | +0.030 |
| `property_type` | 2-4 unit | +0.160 |

### Macroeconomic coefficients (per standard deviation)

| MEV | Coefficient |
|---|---|
| `hpi_yoy` | -0.165 |
| `unemployment_rate` | +0.187 |
| `mortgage_rate` | +0.028 |

### Interactions — where the economics lives

**`current_ltv` x `hpi_yoy` = -0.209**

> A high-LTV borrower is far more sensitive to house prices than a low-LTV one: little equity means a price fall pushes them underwater. The negative sign makes a HIGH current LTV amplify the response to a FALLING HPI.

**`current_ltv` x `unemployment_rate` = +0.083**

> Negative equity plus a job loss is the classic double trigger. Neither alone drives many defaults; together they drive most.

## Commercial real estate (`cre`)

- Accounts: 45,000
- Target: Nonaccrual or downgrade to a default grade (delinquency state 3)
- Intercept: `-6.507` (calibrated to the realised default-rate band)
- Frailty standard deviation: `0.9`
- Seasoning (peak month, height, decay): `(48.0, 0.4, 0.015)`
- Delinquency chain: roll-forward `0.55`, cure base `0.28`

### Static driver coefficients (per standard deviation)

| Driver | Coefficient | Direction |
|---|---|---|
| `dscr` | -0.248 | reduces risk |
| `current_ltv` | +0.171 | raises risk |
| `risk_rating` | +0.189 | raises risk |
| `lease_rollover_pct` | +0.072 | raises risk |

### Categorical level effects

| Variable | Level | Coefficient |
|---|---|---|
| `property_type` | office | +0.150 |
| `property_type` | retail | +0.080 |
| `property_type` | industrial | -0.120 |
| `property_type` | multifamily | -0.100 |
| `property_type` | hospitality | +0.200 |
| `facility_type` | term loan | +0.000 |
| `facility_type` | revolver | +0.050 |
| `guarantor_flag` | Y | -0.220 |
| `guarantor_flag` | N | +0.000 |

### Macroeconomic coefficients (per standard deviation)

| MEV | Coefficient |
|---|---|
| `cre_price_index_yoy` | -0.106 |
| `bbb_yield` | +0.086 |
| `real_gdp_growth` | -0.058 |

### Interactions — where the economics lives

**`property_type` (level `office`) x `cre_price_index_yoy` = -0.240**

> Office is more exposed to the commercial property cycle than the other segments. This term produces the divergence in office performance after 2022.

**`dscr` x `cre_price_index_yoy` = +0.058**

> A thin-DSCR facility has no cushion, so it responds more to a fall in property values. The positive sign strengthens the response for a LOW DSCR.

**`current_ltv` x `cre_price_index_yoy` = -0.048**

> High leverage amplifies the effect of a property price fall.

### Observed versus true

The tape does not carry every driver the hazard used:

- hazard uses `dscr`; the tape ships `dscr_reported`
