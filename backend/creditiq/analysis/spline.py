"""Piecewise-linear spline basis and quantile knot placement.

Shared by the model and by the Explore stage. The Explore stage fits this exact
basis with the same estimator on the same rows, so the curve it previews is the
curve the model fits rather than an approximation of it.
"""

from __future__ import annotations

import numpy as np


def quantile_knots(v: np.ndarray, n_knots: int = 4) -> list[float]:
    """Interior knots at quantiles of the variable's OWN distribution.

    Nobody knows where to put a knot by hand, and asking is a bad interface. The
    standard answer is to place them at quantiles, so they land where the data
    actually is and each interval carries a similar number of observations.

    This function exists because the alternative was worse than useless. The
    spline treatment originally reused the SEASONING knots — 3, 6, 12, ... 144
    months — for every variable. On FICO, which runs 540 to 830, every one of
    those sits below the minimum, so `max(fico - knot, 0)` reduces to
    `fico - knot` for every row. The hinge matrix had rank 2 and the basis
    emitted nine columns, seven of them floating-point residue. The model then
    fitted that residue and reported a BETTER in-sample likelihood for it.
    """
    x = np.asarray(v, dtype=float)
    x = x[np.isfinite(x)]
    if x.size == 0:
        return []
    qs = np.linspace(0, 1, n_knots + 2)[1:-1]        # interior only
    k = np.unique(np.quantile(x, qs))
    # a knot outside the observed range contributes nothing but a rank deficiency
    return [float(z) for z in k if x.min() < z < x.max()]


def spline_basis(v: np.ndarray, knots, fitted: dict | None = None
                  ) -> tuple[np.ndarray, list[str], dict]:
    """Piecewise-linear spline basis, ORTHOGONALIZED.

    The raw hinge basis — the value plus max(value - knot, 0) at each knot — is
    the easy way to write a piecewise-linear spline and it is catastrophically
    collinear: every hinge is a truncated copy of the one before it. Fitted
    directly it produced variance inflation factors above 4,700 and a pair of
    coefficients of +21.5 and -21.8 that cancel to nothing. Those numbers are not
    wrong, but no validator will accept a specification card that shows them.

    A QR decomposition returns an orthonormal basis spanning EXACTLY the same
    function space, so the fitted seasoning curve is identical while the variance
    inflation drops to one. The individual coefficients then carry no separate
    meaning — which is honest, because a spline's shape is the quantity of
    interest, not its basis weights. The Model surface plots the curve.
    """
    def raw(vv, ks):
        cols = [vv.astype(float)]
        nm = ["value"]
        for kk in ks:
            cols.append(np.maximum(vv - kk, 0.0))
            nm.append(f"gt{kk}")
        return np.column_stack(cols), nm

    if fitted is not None:
        # APPLY a previously fitted basis. The knot set and the orthogonalising
        # map must both come from training: a projection ages accounts past knots
        # that were dead in the fit sample, which would otherwise change the
        # column count, and re-running QR on new data produces a DIFFERENT basis
        # spanning the same space — the fitted coefficients would then be applied
        # to the wrong vectors.
        B, _ = raw(v, fitted["knots"])
        B = (B - np.asarray(fitted["center"])) @ np.asarray(fitted["rinv"])
        B = B * np.asarray(fitted["signs"])
        return B, [f"basis{i + 1}" for i in range(B.shape[1])], fitted

    B, names = raw(v, knots)
    keep = B.std(axis=0) > 1e-9              # a knot beyond the data's range is dead
    live_knots = [k for k, kp in zip(knots, keep[1:]) if kp]
    B = B[:, keep]
    names = [n for n, k in zip(names, keep) if k]
    meta: dict = {"knots": live_knots}
    if B.shape[1] > 1:
        center = B.mean(axis=0)
        Bc = B - center
        # A non-zero standard deviation is NOT enough to prove a hinge adds
        # anything: hinges below the data's minimum are all affine copies of the
        # variable and survive that check while contributing nothing. Truncate to
        # the numerical rank, or the basis emits orthonormal columns of pure
        # floating-point residue and the model happily fits them.
        rank = int(np.linalg.matrix_rank(Bc, tol=1e-8))
        Q, R = np.linalg.qr(Bc)
        Q, R = Q[:, :rank], R[:rank]
        signs = np.sign(np.sum(Q * Bc[:, :rank], axis=0))
        signs[signs == 0] = 1.0
        B = Q * signs
        names = [f"basis{i + 1}" for i in range(B.shape[1])]
        meta |= {"center": center.tolist(),
                 "rinv": np.linalg.pinv(R).tolist(), "signs": signs.tolist()}
    else:
        meta |= {"center": [0.0] * B.shape[1],
                 "rinv": np.eye(B.shape[1]).tolist(), "signs": [1.0] * B.shape[1]}
    return B, names, meta
