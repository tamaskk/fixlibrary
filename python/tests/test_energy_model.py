from __future__ import annotations

from typing import Any

import numpy
import pytest

from fixlib_py.analysis import energy_model


def samples_of(count: int, noise: float = 0.0, seed: int = 0) -> list[dict[str, Any]]:
    """Ratings that follow a known rule: loudness up, percussion up, centroid nothing."""
    rng = numpy.random.default_rng(seed)
    result = []
    for _ in range(count):
        rms = rng.uniform(-20, -6)
        hits = rng.uniform(0.2, 0.8)
        centroid = rng.uniform(1000, 4000)
        score = 1 + 9 * (0.6 * (rms + 20) / 14 + 0.4 * (hits - 0.2) / 0.6)
        rating = int(min(10, max(1, round(score + rng.normal(0, noise)))))
        result.append(
            {
                "features": {"rmsDb": rms, "percussiveRatio": hits, "centroid": centroid},
                "rating": rating,
            }
        )
    return result


def predict(model: dict[str, Any], features: dict[str, float]) -> float:
    return model["intercept"] + sum(
        w * (features[name] - m) / s
        for name, m, s, w in zip(
            model["names"], model["means"], model["scales"], model["weights"], strict=True
        )
    )


def test_learns_a_known_rule_from_25_ratings() -> None:
    samples = samples_of(25)

    model = energy_model.fit_samples(samples)

    weights = dict(zip(model["names"], model["weights"], strict=True))
    assert weights["rmsDb"] > weights["percussiveRatio"] > abs(weights["centroid"])
    assert model["looMae"] <= 1.5


def test_the_leave_one_out_error_grows_with_noisy_ratings() -> None:
    clean = energy_model.fit_samples(samples_of(25))
    noisy = energy_model.fit_samples(samples_of(25, noise=3.0))

    assert noisy["looMae"] > clean["looMae"]


def test_predicts_the_ratings_it_was_fitted_on_closely() -> None:
    samples = samples_of(30)

    model = energy_model.fit_samples(samples)

    errors = [abs(predict(model, s["features"]) - s["rating"]) for s in samples]
    assert numpy.mean(errors) < 1.0


def test_a_feature_that_never_varies_gets_no_weight() -> None:
    samples = samples_of(20)
    for sample in samples:
        sample["features"]["centroid"] = 2000.0

    model = energy_model.fit_samples(samples)

    weights = dict(zip(model["names"], model["weights"], strict=True))
    assert weights["centroid"] == 0
    assert all(numpy.isfinite(model["weights"]))


@pytest.mark.parametrize(
    "samples",
    [
        [],
        "nope",
        samples_of(4),
        [{"features": {"a": 1.0}, "rating": 11}] * 5,
        [{"features": {"a": 1.0}, "rating": True}] * 5,
        [{"features": {"a": float("nan")}, "rating": 5}] * 5,
        [{"features": {"a": 1.0}, "rating": 5, "extra": 1}] * 5,
        [{"features": {"a": 1.0}, "rating": 5}] * 4 + [{"features": {"b": 1.0}, "rating": 5}],
    ],
)
def test_refuses_samples_that_are_no_ratings(samples: Any) -> None:
    with pytest.raises(ValueError):
        energy_model.fit_samples(samples)
