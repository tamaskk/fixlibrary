from __future__ import annotations

import pytest

from fixlib_py import keys

# The table of the product spec, written out once more so a typo in `KEYS` shows.
SPEC = [
    ("1A", "Abm"),
    ("2A", "Ebm"),
    ("3A", "Bbm"),
    ("4A", "Fm"),
    ("5A", "Cm"),
    ("6A", "Gm"),
    ("7A", "Dm"),
    ("8A", "Am"),
    ("9A", "Em"),
    ("10A", "Bm"),
    ("11A", "F#m"),
    ("12A", "Dbm"),
    ("1B", "B"),
    ("2B", "F#"),
    ("3B", "Db"),
    ("4B", "Ab"),
    ("5B", "Eb"),
    ("6B", "Bb"),
    ("7B", "F"),
    ("8B", "C"),
    ("9B", "G"),
    ("10B", "D"),
    ("11B", "A"),
    ("12B", "E"),
]

# The names Essentia's key detection uses for the twelve tonics.
ESSENTIA_TONICS = ["A", "Bb", "B", "C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab"]


def test_holds_the_24_keys_of_the_spec() -> None:
    assert [(key.camelot, key.musical) for key in keys.KEYS] == SPEC


@pytest.mark.parametrize(("camelot", "musical"), SPEC)
def test_maps_every_key_by_its_tonic_and_scale(camelot: str, musical: str) -> None:
    minor = musical.endswith("m")
    tonic = musical[:-1] if minor else musical

    key = keys.key_of(tonic, "minor" if minor else "major")

    assert key is not None
    assert (key.camelot, key.musical) == (camelot, musical)


def test_moves_a_fifth_up_with_every_step_of_the_wheel() -> None:
    for key in keys.KEYS:
        number = int(key.camelot[:-1])
        first = 8 if key.scale == "minor" else 11

        assert key.pitch_class == (first + 7 * (number - 1)) % 12


@pytest.mark.parametrize(
    ("sharp", "flat", "scale", "camelot"),
    [
        ("C#", "Db", "major", "3B"),
        ("C#", "Db", "minor", "12A"),
        ("G#", "Ab", "minor", "1A"),
        ("D#", "Eb", "minor", "2A"),
        ("A#", "Bb", "major", "6B"),
        ("Gb", "F#", "major", "2B"),
    ],
)
def test_two_names_of_one_pitch_are_one_key(
    sharp: str, flat: str, scale: str, camelot: str
) -> None:
    for tonic in (sharp, flat):
        key = keys.key_of(tonic, scale)

        assert key is not None
        assert key.camelot == camelot


def test_every_tonic_essentia_names_is_a_key_in_both_scales() -> None:
    found = {keys.key_of(tonic, scale) for tonic in ESSENTIA_TONICS for scale in keys.SCALES}

    assert None not in found
    assert len(found) == 24


@pytest.mark.parametrize("note", ["", "H", "C##", "Am", "8A"])
def test_refuses_what_is_no_note_name(note: str) -> None:
    assert keys.pitch_class_of(note) is None


@pytest.mark.parametrize(
    ("text", "camelot"),
    [("8A", "8A"), ("11b", "11B"), ("Am", "8A"), ("F#m", "11A"), ("Gbm", "11A"), ("Db", "3B")],
)
def test_parses_a_key_in_either_notation(text: str, camelot: str) -> None:
    key = keys.parse_key(text)

    assert key is not None
    assert key.camelot == camelot


@pytest.mark.parametrize("text", ["", "13A", "8C", "Hm", "minor"])
def test_parses_nothing_else_as_a_key(text: str) -> None:
    assert keys.parse_key(text) is None
