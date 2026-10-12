"""Musical keys in Camelot and musical notation.

Mirrors src/shared/keys.ts by hand; change both in the same commit.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

SCALES = ("minor", "major")


@dataclass(frozen=True)
class Key:
    """One of the 24 keys. `pitch_class` is the tonic as semitones above C."""

    camelot: str
    musical: str
    pitch_class: int
    scale: str


KEYS: tuple[Key, ...] = (
    Key("1A", "Abm", 8, "minor"),
    Key("2A", "Ebm", 3, "minor"),
    Key("3A", "Bbm", 10, "minor"),
    Key("4A", "Fm", 5, "minor"),
    Key("5A", "Cm", 0, "minor"),
    Key("6A", "Gm", 7, "minor"),
    Key("7A", "Dm", 2, "minor"),
    Key("8A", "Am", 9, "minor"),
    Key("9A", "Em", 4, "minor"),
    Key("10A", "Bm", 11, "minor"),
    Key("11A", "F#m", 6, "minor"),
    Key("12A", "Dbm", 1, "minor"),
    Key("1B", "B", 11, "major"),
    Key("2B", "F#", 6, "major"),
    Key("3B", "Db", 1, "major"),
    Key("4B", "Ab", 8, "major"),
    Key("5B", "Eb", 3, "major"),
    Key("6B", "Bb", 10, "major"),
    Key("7B", "F", 5, "major"),
    Key("8B", "C", 0, "major"),
    Key("9B", "G", 7, "major"),
    Key("10B", "D", 2, "major"),
    Key("11B", "A", 9, "major"),
    Key("12B", "E", 4, "major"),
)

_NATURAL_PITCH_CLASSES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_NOTE = re.compile(r"^([A-Ga-g])([#♯b♭]?)$")
_BY_TONIC = {(key.pitch_class, key.scale): key for key in KEYS}
_BY_CAMELOT = {key.camelot: key for key in KEYS}


def pitch_class_of(note: str) -> int | None:
    """The pitch class of a note name such as `C#`, `Db` or `A`, or None.

    Two names of one pitch give one number, which is how `C#` and `Db` end up as the
    same key.
    """
    match = _NOTE.match(note.strip())
    if match is None:
        return None
    accidental = match.group(2)
    shift = 0 if accidental == "" else 1 if accidental in "#♯" else -1
    return (_NATURAL_PITCH_CLASSES[match.group(1).upper()] + shift) % 12


def key_of(tonic: str, scale: str) -> Key | None:
    """The key with this tonic and scale, or None when the tonic is no note name."""
    pitch_class = pitch_class_of(tonic)
    if pitch_class is None:
        return None
    return _BY_TONIC.get((pitch_class, scale))


def key_of_camelot(camelot: str) -> Key | None:
    """The key a Camelot code names, in any letter case, or None when it names none."""
    return _BY_CAMELOT.get(camelot.strip().upper())


def parse_key(text: str) -> Key | None:
    """A key written either way: `8A`, `Am`, `F#m`, `Db`. None for anything else."""
    by_code = key_of_camelot(text)
    if by_code is not None:
        return by_code
    name = text.strip()
    if name.endswith("m"):
        return key_of(name[:-1], "minor")
    return key_of(name, "major")
