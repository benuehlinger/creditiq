/** Methodology content for the drawer.
 *
 *  Every computed quantity in the app has an entry. Cited against the standard
 *  references where one applies. Nothing here claims regulatory approval — this
 *  is a demonstration of capability, and the wording keeps that clear.
 */

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'formula'; text: string }
  | { kind: 'note'; text: string }

export interface Entry { title: string; body: Block[]; references?: string[] }

export const METHODOLOGY: Record<string, Entry> = {
  'data-health': {
    title: 'Panel integrity and data health',
    body: [
      { kind: 'text', text: 'A loan tape is a panel: one row per account per performance date. The integrity checks ask whether it is a valid panel at all, before anything is modelled on it.' },
      { kind: 'text', text: 'Duplicate account-date keys break every panel method, because each observation is assumed to be one account-month. Gaps in the monthly sequence are not the same as a censored account: a missing month silently removes exposure from the denominator and biases a hazard model. Rows recorded after a terminal event inflate the denominator and depress every rate.' },
      { kind: 'note', text: 'These failures do not stop a model fitting. They produce a model that fits well and answers wrongly, which is worse.' },
      { kind: 'text', text: 'The health score weights a critical structural failure five times a cosmetic warning, so passing a handful of easy checks cannot offset a broken key.' },
      { kind: 'text', text: 'Outliers use Tukey’s far fence at three interquartile ranges rather than the usual 1.5. Credit data is right-skewed by nature, and the 1.5 fence flags a quarter of an income column, which buries the signal.' },
    ],
    references: ['SR 11-7, Guidance on Model Risk Management — data quality and model inputs'],
  },
  'default-rate': {
    title: 'Annualized default rate',
    body: [
      { kind: 'text', text: 'Computed at the observation level and then aggregated by performance date, which is the frame a discrete-time hazard model uses.' },
      { kind: 'formula', text: 'rate(t) = defaults(t) / account-months(t) x 12 x 100' },
      { kind: 'text', text: 'The denominator is account-months at risk in that month, not accounts outstanding at a point in time. An account that defaults, pays off or matures leaves the denominator from the following month, so the rate is a genuine hazard rather than a stock ratio.' },
      { kind: 'note', text: 'Multiplying a monthly rate by twelve annualizes it on a simple basis. It is not compounded, which is the market convention for reporting a monthly default rate.' },
    ],
  },
  'mev-catalog': {
    title: 'Why only the CCAR variables',
    body: [
      { kind: 'text', text: 'The macroeconomic catalog is restricted to the Federal Reserve supervisory variables. They are the only macroeconomic variables with publicly published FORWARD paths.' },
      { kind: 'note', text: 'A variable with no forward path cannot condition a scenario projection, however predictive it is in sample. Choosing a predictor you cannot project is a common and expensive mistake.' },
      { kind: 'text', text: 'History comes from FRED. Forward paths come from the Fed’s published supervisory scenarios. Three variables ship as documented proxies, because the exact series is either retired from FRED or licence-restricted; each one is labelled where it appears.' },
    ],
    references: ['Board of Governors, 2026 Supervisory Scenarios for the Dodd-Frank Act stress test'],
  },
  'frequency-reconciliation': {
    title: 'Frequency reconciliation',
    body: [
      { kind: 'text', text: 'FRED is mostly monthly, with some daily, weekly and quarterly series. CCAR is quarterly. The loan panel is monthly. The canonical grain is monthly and every conversion is driven by per-variable metadata, never by one global rule.' },
      { kind: 'text', text: 'Higher frequency to monthly collapses by the variable’s own aggregation rule: period-average for rates, end-of-period where the CCAR definition is end-of-period, and period-maximum for the VIX, which the Fed defines that way.' },
      { kind: 'text', text: 'Quarterly to monthly uses Denton-Cholette proportional first-difference benchmarking, against a monthly indicator series where a genuine one exists.' },
      { kind: 'formula', text: 'minimise  sum_t ( x_t / z_t  -  x_{t-1} / z_{t-1} )^2\nsubject to      C x  =  y      (the published quarterly values)' },
      { kind: 'note', text: 'The constraint is an identity, not an approximation: the derived monthly series aggregates back to the published quarterly value to 2.8e-16 relative. Straight-line interpolation between quarter-end points does NOT satisfy this, and the test suite asserts that it fails.' },
      { kind: 'text', text: 'A growth rate is never interpolated directly. It is converted to a level index, the level is benchmarked, and the result is re-differenced. A ratio of averages is not the average of ratios, and getting this backwards is the most common macro-modelling error.' },
    ],
  },
  'scenario-splice': {
    title: 'Joining history to a scenario',
    body: [
      { kind: 'text', text: 'Two different things meet at the seam and only one of them is a problem.' },
      { kind: 'text', text: 'The problem is scale. Where our historical proxy is a different index from the Fed’s variable, the two sit on different arbitrary bases: the reconstructed commercial property index reads about 151 where the Fed’s reads 309.5. Such a variable is rebased multiplicatively, which preserves the scenario’s percentage path exactly and lands it on our history’s scale.' },
      { kind: 'note', text: 'What is NOT a problem is a jump in a rate at the first projected quarter. Unemployment moving from an actual 4.1% to a projected 5.9% is the shock arriving. Shifting it away would cap severely adverse unemployment at 8.2% instead of 10.0%. Rates, yields, growth rates and the VIX are never shifted.' },
      { kind: 'text', text: 'The seam is drawn on every chart as a vertical rule, with the projected side in a distinct line style. It is annotated, not hidden.' },
    ],
  },
}
