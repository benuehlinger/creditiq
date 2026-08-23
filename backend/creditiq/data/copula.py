"""Correlated attribute draws through a Gaussian copula.

Independent draws are the tell that gives a synthetic loan tape away. In a real
book FICO, DTI, income and LTV move together: high-income borrowers carry lower
DTI, thin-file borrowers carry higher utilization, and so on. A model fitted on
independent draws finds clean, non-collinear predictors that no real portfolio
would ever hand you — and the correlation screen in the Explore surface would
have nothing to find.

A Gaussian copula separates the two things we want to control:
  - the SHAPE of each variable on its own (its marginal), and
  - the DEPENDENCE between them (the correlation of the latent normals).

Draw correlated standard normals, map each through its own normal CDF to a
uniform, then push that uniform through the target marginal's inverse CDF. The
rank correlation survives; the marginal shapes are whatever we asked for.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np
from scipy import stats


@dataclass(frozen=True)
class Marginal:
    """One attribute: its name and the inverse CDF that gives it its shape."""
    name: str
    ppf: Callable[[np.ndarray], np.ndarray]
    decimals: int | None = None
    lo: float | None = None
    hi: float | None = None

    def apply(self, u: np.ndarray) -> np.ndarray:
        raw = np.asarray(self.ppf(u))
        if raw.dtype.kind in "OUS":       # a categorical marginal — no numeric shaping
            return raw
        x = raw.astype(float)
        if self.lo is not None or self.hi is not None:
            x = np.clip(x, self.lo, self.hi)
        if self.decimals is not None:
            x = np.round(x, self.decimals)
        return x


def nearest_positive_definite(corr: np.ndarray) -> np.ndarray:
    """A hand-written correlation matrix is often not quite a valid one.

    Rather than fail, project it to the nearest positive definite matrix by
    clipping the eigenvalues and renormalising the diagonal. This keeps the
    generator authorable — the coefficients live in a readable table and the
    numerics stay valid.
    """
    sym = (corr + corr.T) / 2.0
    vals, vecs = np.linalg.eigh(sym)
    if vals.min() > 1e-8:
        return sym
    vals = np.clip(vals, 1e-6, None)
    fixed = vecs @ np.diag(vals) @ vecs.T
    d = np.sqrt(np.diag(fixed))
    return fixed / np.outer(d, d)


def build_correlation(names: list[str], pairs: dict[tuple[str, str], float]) -> np.ndarray:
    """Assemble a correlation matrix from the pairs we actually care about."""
    idx = {n: i for i, n in enumerate(names)}
    C = np.eye(len(names))
    for (a, b), r in pairs.items():
        if a not in idx or b not in idx:
            raise KeyError(f"correlation pair ({a}, {b}) names an unknown attribute")
        C[idx[a], idx[b]] = C[idx[b], idx[a]] = r
    return nearest_positive_definite(C)


def draw(n: int, marginals: list[Marginal], corr: np.ndarray,
         rng: np.random.Generator) -> dict[str, np.ndarray]:
    """n correlated draws, one array per marginal, in the requested shapes."""
    if corr.shape != (len(marginals), len(marginals)):
        raise ValueError("correlation matrix does not match the marginal count")
    L = np.linalg.cholesky(nearest_positive_definite(corr))
    z = rng.standard_normal((n, len(marginals))) @ L.T
    u = stats.norm.cdf(z)
    # keep the uniforms off the exact boundary so an unbounded ppf stays finite
    u = np.clip(u, 1e-9, 1 - 1e-9)
    return {m.name: m.apply(u[:, i]) for i, m in enumerate(marginals)}


# ── marginal shapes used by the portfolio definitions ────────────────────────
def beta_scaled(a: float, b: float, lo: float, hi: float):
    """Beta on [lo, hi]. The workhorse for bounded attributes (FICO, LTV, DTI)."""
    return lambda u: lo + (hi - lo) * stats.beta.ppf(u, a, b)


def lognormal(mu: float, sigma: float):
    return lambda u: stats.lognorm.ppf(u, s=sigma, scale=np.exp(mu))


def gamma(shape: float, scale: float):
    return lambda u: stats.gamma.ppf(u, a=shape, scale=scale)


def normal(mu: float, sigma: float):
    return lambda u: stats.norm.ppf(u, loc=mu, scale=sigma)


def uniform(lo: float, hi: float):
    return lambda u: lo + (hi - lo) * u


def categorical(levels: list[str], probs: list[float]):
    """A category drawn on the copula's uniform, so it CORRELATES with the rest.

    Drawing categories independently would break the dependence structure at
    exactly the variables an analyst segments on (occupancy, property type,
    channel), so they ride the copula like everything else.
    """
    cum = np.cumsum(np.asarray(probs, dtype=float))
    cum = cum / cum[-1]
    arr = np.asarray(levels, dtype=object)

    def ppf(u: np.ndarray) -> np.ndarray:
        return arr[np.searchsorted(cum, np.asarray(u), side="left").clip(0, len(arr) - 1)]
    return ppf
