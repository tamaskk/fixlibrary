"""Turns the official htdemucs package into the tensor file the sidecar loads.

Run by scripts/fetch-demucs-weights.sh. This is the one place that unpickles the
package, and the package names the class Demucs would build, so what protects it is
the SHA-256 the shell script pins: this script checks it again before loading, and
the check of the class afterwards is a sanity check only. Writes `state.pt` (tensors
only, loaded by the sidecar with `weights_only=True`); the model's arguments are fixed
in fixlib_py/analysis/stems.py.

    python -I scripts/convert-demucs-weights.py <package.th> <sha256> <output folder>
"""

from __future__ import annotations

import hashlib
import os
import sys

import torch

EXPECTED_CLASS = "demucs.htdemucs.HTDemucs"


def sha256_of(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for block in iter(lambda: file.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main(package_path: str, expected_sha256: str, output_dir: str) -> None:
    if sha256_of(package_path) != expected_sha256:
        raise SystemExit("the package is not the one that was checked")
    package = torch.load(package_path, map_location="cpu", weights_only=False)
    klass = package["klass"]
    if f"{klass.__module__}.{klass.__qualname__}" != EXPECTED_CLASS or package["args"]:
        raise SystemExit("the package is not the htdemucs model this app uses")
    state = package["state"]
    if not all(isinstance(tensor, torch.Tensor) for tensor in state.values()):
        raise SystemExit("the state holds more than tensors")
    os.makedirs(output_dir, exist_ok=True)
    torch.save(dict(state), os.path.join(output_dir, "state.pt"))


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("usage: convert-demucs-weights.py <package.th> <sha256> <output folder>")
    main(sys.argv[1], sys.argv[2], sys.argv[3])
