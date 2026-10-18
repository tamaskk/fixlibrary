"""The model that turns energy features into the user's own feeling for energy (T-024).

Mirrored by `energy.fit` in src/shared/rpc.ts.

A ridge regression on standardized features, fitted to the tracks the user rated 1 to
10. Its weights are applied in the app (src/shared/energy.ts): a dot product needs no
sidecar. The leave-one-out error tells the user how well it follows their ratings.
"""

from __future__ import annotations

import math
from typing import Any

from fixlib_py.server import rpc

# Enough to keep the weights finite with few ratings and features that move together.
RIDGE_LAMBDA = 1.0
MIN_SAMPLES = 5
MAX_SAMPLES = 1000
MAX_FEATURES = 32


def _check(samples: object) -> tuple[list[str], list[list[float]], list[float]]:
    if not isinstance(samples, list) or not MIN_SAMPLES <= len(samples) <= MAX_SAMPLES:
        raise ValueError(f"samples must be a list of {MIN_SAMPLES} to {MAX_SAMPLES} ratings")
    names: list[str] | None = None
    rows: list[list[float]] = []
    ratings: list[float] = []
    for sample in samples:
        if not isinstance(sample, dict) or set(sample) != {"features", "rating"}:
            raise ValueError("a sample is {features, rating}")
        features, rating = sample["features"], sample["rating"]
        if not isinstance(features, dict) or not 1 <= len(features) <= MAX_FEATURES:
            raise ValueError("features must be a map of names to numbers")
        if names is None:
            names = sorted(features)
        if sorted(features) != names:
            raise ValueError("every sample must have the same features")
        row = [features[name] for name in names]
        if not all(
            isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v) for v in row
        ):
            raise ValueError("a feature is not a finite number")
        if isinstance(rating, bool) or not isinstance(rating, int) or not 1 <= rating <= 10:
            raise ValueError("a rating is a whole number from 1 to 10")
        rows.append([float(v) for v in row])
        ratings.append(float(rating))
    assert names is not None
    return names, rows, ratings


def _solve(x: Any, y: Any) -> tuple[Any, float]:
    """Ridge weights for standardized `x`, and the intercept (the mean, not penalized)."""
    import numpy

    intercept = float(y.mean())
    gram = x.T @ x + RIDGE_LAMBDA * numpy.eye(x.shape[1])
    return numpy.linalg.solve(gram, x.T @ (y - intercept)), intercept


def fit_samples(samples: object) -> dict[str, Any]:
    """The model of rated samples: names, means, scales, weights, intercept, LOO error."""
    import numpy

    names, rows, ratings = _check(samples)
    data = numpy.array(rows)
    y = numpy.array(ratings)
    means = data.mean(axis=0)
    # A feature that does not vary among the samples tells nothing; it stays at weight 0.
    scales = data.std(axis=0)
    scales[scales == 0] = 1.0
    x = (data - means) / scales
    weights, intercept = _solve(x, y)

    errors = []
    for left_out in range(len(y)):
        keep = numpy.arange(len(y)) != left_out
        # Standardized by the whole sample: the left-out row's scale barely moves it.
        w, b = _solve(x[keep], y[keep])
        errors.append(abs(float(x[left_out] @ w + b) - y[left_out]))
    return {
        "names": names,
        "means": [float(v) for v in means],
        "scales": [float(v) for v in scales],
        "weights": [float(v) for v in weights],
        "intercept": intercept,
        "looMae": float(numpy.mean(errors)),
    }


@rpc("energy.fit")
def fit(samples: list[dict[str, Any]]) -> dict[str, Any]:
    """Fit the energy model to the tracks the user rated. Pure: reads nothing."""
    return fit_samples(samples)
