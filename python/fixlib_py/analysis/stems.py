"""The stems of a track, kept as loudness envelopes (T-028).

Demucs (htdemucs) separates the audio into drums, bass, other and vocals. What is kept
is not the audio of the stems, which would be hundreds of GB for a library, but the
RMS of each stem in 100 ms windows, as float16, in `<stems folder>/<track id>.npz`.
The cue placement of T-029 reads the bassline and the vocals from them.

The model's arguments are fixed here, and its tensors come from the file of
scripts/fetch-demucs-weights.sh in the folder the app names (`FIXLIB_MODELS_DIR`),
loaded with `weights_only`: no file can run code, nor ask for another model. It is
loaded once, in the single Demucs worker, and kept there.

The audio is kept as 16 bit and separated a minute at a time with context on both
sides, so neither the memory nor the time of one step grows with the length of the
track; a job told to stop answers at once, and its worker ends after the minute it
is in, writing nothing.

Mirrored by `analysis.stems` in src/shared/rpc.ts.
"""

from __future__ import annotations

import logging
import os
import re
import stat
import threading
import time
from collections.abc import Callable
from concurrent.futures import wait
from fractions import Fraction
from typing import Any

from fixlib_py import server
from fixlib_py.analysis.decode import (
    SAMPLE_RATE,
    ToolStopped,
    _samples_of_wav,
    decode_wav,
)
from fixlib_py.server import JobCancelled, cancellable, raise_if_cancelled, rpc

logger = logging.getLogger(__name__)

# Stored with every result: a track is separated again only when this changes. Change
# it with the model or the envelopes, together with STEMS_ANALYZER_VERSION in
# src/shared/rpc.ts.
ANALYZER_VERSION = "htdemucs-8726e21a-rms100ms-1"
STEMS = ("drums", "bass", "other", "vocals")
WINDOW_SECONDS = 0.1
WINDOW = int(SAMPLE_RATE * WINDOW_SECONDS)
# What Demucs separates at a time, and the audio it is shown on each side so that the
# edges of a minute sound as they do inside the track. Whole windows, so the
# envelopes of the minutes join without a seam.
CHUNK_SECONDS = 60
CONTEXT_SECONDS = 5
# Shorter than this there is nothing to place a cue on; longer is cut here.
MIN_SECONDS = 5
MAX_SECONDS = 20 * 60
# Twenty minutes from a slow external drive take longer than a tempo's ten.
DECODE_TIMEOUT_S = 180

STEMS_DIR_ENV = "FIXLIB_STEMS_DIR"
MODELS_DIR_ENV = "FIXLIB_MODELS_DIR"
MODEL_FILE = os.path.join("htdemucs", "state.pt")
_TRACK_ID = re.compile(r"^[1-9][0-9]{0,15}$")
# How often a waiting call looks whether it was told to stop.
_POLL_S = 0.2

# The arguments htdemucs was trained with (`kwargs` of the official file). Fixed here,
# so the model built is always this one, whatever lies beside its weights.
HTDEMUCS_KWARGS: dict[str, Any] = {
    "audio_channels": 2,
    "bottom_channels": 512,
    "cac": True,
    "channels": 48,
    "channels_time": None,
    "context": 1,
    "context_enc": 0,
    "dconv_comp": 8,
    "dconv_depth": 2,
    "dconv_init": 0.001,
    "dconv_mode": 3,
    "depth": 4,
    "emb_scale": 10,
    "emb_smooth": True,
    "end_iters": 0,
    "freq_emb": 0.2,
    "growth": 2,
    "kernel_size": 8,
    "multi_freqs": [],
    "multi_freqs_depth": 3,
    "nfft": 4096,
    "norm_groups": 4,
    "norm_starts": 4,
    "rescale": 0.1,
    "rewrite": True,
    "samplerate": SAMPLE_RATE,
    "segment": Fraction(39, 5),
    "sources": list(STEMS),
    "stride": 4,
    "t_auto_sparsity": False,
    "t_cape_augment": True,
    "t_cape_glob_loc_scale": [5000.0, 1.0, 1.4],
    "t_cape_mean_normalize": True,
    "t_cross_first": False,
    "t_dropout": 0.02,
    "t_emb": "sin",
    "t_gelu": True,
    "t_global_window": 100,
    "t_group_norm": False,
    "t_heads": 8,
    "t_hidden_scale": 4.0,
    "t_layer_scale": True,
    "t_layers": 5,
    "t_lr": None,
    "t_mask_random_seed": 42,
    "t_mask_type": "diag",
    "t_max_period": 10000.0,
    "t_max_positions": 10000,
    "t_norm_first": True,
    "t_norm_in": True,
    "t_norm_in_group": False,
    "t_norm_out": True,
    "t_sin_random_shift": 0,
    "t_sparse_attn_window": 400,
    "t_sparse_cross_attn": False,
    "t_sparse_self_attn": False,
    "t_sparsity": 0.95,
    "t_weight_decay": 0.0,
    "t_weight_pos_embed": 1.0,
    "time_stride": 2,
    "wiener_iters": 0,
    "wiener_residual": False,
}

_model_lock = threading.Lock()
_model: Any = None


class Refused(ValueError):
    """What was asked cannot be done here: no folder, no model."""


def _open_app_dir(variable: str, what: str) -> int:
    """The folder the app named, opened once: what is written goes into this folder.

    A link in its place is refused; later steps go through the descriptor, so the
    folder cannot be swapped between the check and the write.
    """
    folder = os.environ.get(variable, "")
    if not os.path.isabs(folder):
        raise Refused(f"no {what} folder was named")
    try:
        descriptor = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError:
        raise Refused(f"the {what} folder is not there, or is no folder") from None
    if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
        os.close(descriptor)
        raise Refused(f"the {what} folder is not a folder")
    return descriptor


def stems_dir() -> str:
    """The folder the app named for envelopes, checked."""
    os.close(_open_app_dir(STEMS_DIR_ENV, "stems"))
    return os.environ[STEMS_DIR_ENV]


def envelope_name(track_id: int) -> str:
    """The name of a track's envelopes: its id, nothing a caller can steer."""
    if isinstance(track_id, bool) or not isinstance(track_id, int):
        raise ValueError("trackId must be a whole number")
    name = str(track_id)
    if not _TRACK_ID.match(name):
        raise ValueError("trackId must be a positive whole number")
    return f"{name}.npz"


def device_name() -> str:
    """MPS on Apple Silicon, where the spike of T-002 ran it; the CPU elsewhere."""
    import torch

    return "mps" if torch.backends.mps.is_available() else "cpu"


def load_model() -> Any:
    """The htdemucs model, built once from the fixed arguments and the app's tensors."""
    global _model
    with _model_lock:
        if _model is not None:
            return _model
        # Before torch is imported: an operator MPS lacks runs on the CPU, not fails.
        os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        import torch
        from demucs.htdemucs import HTDemucs

        models = _open_app_dir(MODELS_DIR_ENV, "models")
        try:
            descriptor = os.open(MODEL_FILE, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=models)
        except OSError:
            raise Refused("the model is not installed") from None
        finally:
            os.close(models)
        model = HTDemucs(**HTDEMUCS_KWARGS)
        with os.fdopen(descriptor, "rb") as file:
            # Tensors only: a file that holds anything else is refused, never run.
            state = torch.load(file, map_location="cpu", weights_only=True)
        model.load_state_dict(state, strict=True)
        if list(model.sources) != list(STEMS) or model.samplerate != SAMPLE_RATE:
            raise Refused("the model is not the htdemucs model of this app")
        model.eval()
        _model = model.to(device_name())
        return _model


def free_device_memory() -> None:
    """Gives back what MPS keeps cached after a track: the worker lives for days."""
    if _model is None:
        return
    import torch

    if device_name() == "mps":
        torch.mps.empty_cache()


Separator = Callable[[Any], Any]
"""Separates stereo float32 samples (2, n) into stems (4, 2, n), in STEMS order."""


def demucs_separator(model: Any) -> Separator:
    def separate(audio: Any) -> Any:
        import torch
        from demucs.apply import apply_model

        with torch.inference_mode():
            mix = torch.from_numpy(audio)[None]
            # Normalized as Demucs does it for the model's training data.
            reference = mix.mean(1)
            mean, std = reference.mean(), reference.std() + 1e-8
            stems = apply_model(
                model,
                (mix - mean) / std,
                device=device_name(),
                shifts=0,
                split=True,
                overlap=0.25,
                progress=False,
            )[0]
            return (stems * std + mean).cpu().numpy()

    return separate


def rms_envelopes(stems: Any) -> Any:
    """The RMS of each stem in WINDOW-sample windows, over both channels: (4, frames).

    A last window that is not whole is measured over what it has.
    """
    import numpy

    count, channels, length = stems.shape
    whole = length // WINDOW
    parts = []
    if whole > 0:
        body = stems[:, :, : whole * WINDOW].reshape(count, channels, whole, WINDOW)
        parts.append(numpy.sqrt(numpy.square(body).sum(axis=(1, 3)) / (WINDOW * channels)))
    tail = length - whole * WINDOW
    if tail > 0:
        rest = stems[:, :, whole * WINDOW :]
        parts.append(numpy.sqrt(numpy.square(rest).sum(axis=(1, 2)) / (tail * channels))[:, None])
    return numpy.concatenate(parts, axis=1)


def envelopes_of(audio: Any, separate: Separator, stop: threading.Event | None = None) -> Any:
    """The envelopes of stereo samples (2, n), separated a CHUNK_SECONDS at a time.

    The samples may be 16 bit: only the minute at hand, with its context, is made
    float. Each chunk is separated with CONTEXT_SECONDS of the audio around it, and
    only its own part is measured. The stems are dropped chunk by chunk.
    """
    import numpy

    scale = 32768.0 if audio.dtype == numpy.int16 else 1.0
    length = audio.shape[1]
    chunk = CHUNK_SECONDS * SAMPLE_RATE
    context = CONTEXT_SECONDS * SAMPLE_RATE
    parts = []
    for start in range(0, length, chunk):
        if stop is not None:
            raise_if_cancelled(stop)
        end = min(start + chunk, length)
        left = max(0, start - context)
        right = min(length, end + context)
        piece = numpy.array(audio[:, left:right], dtype=numpy.float32, order="C")
        piece /= scale
        stems = separate(piece)
        del piece
        parts.append(rms_envelopes(stems[:, :, start - left : end - left]))
        del stems
    return numpy.concatenate(parts, axis=1).astype(numpy.float16)


def write_envelopes(name: str, envelopes: Any, stop: threading.Event | None = None) -> int:
    """Writes the envelopes into the stems folder whole or not at all: a new temp file
    there, then a rename, unless the job was told to stop meanwhile.

    Returns the size of the file.
    """
    import numpy

    folder = _open_app_dir(STEMS_DIR_ENV, "stems")
    temp = f".{name}.{os.getpid()}.{threading.get_ident()}.fixlib-tmp"
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        descriptor = os.open(temp, flags, 0o600, dir_fd=folder)
        try:
            with os.fdopen(descriptor, "wb") as file:
                numpy.savez_compressed(
                    file,
                    envelopes=envelopes,
                    stems=numpy.array(STEMS),
                    window_seconds=numpy.float32(WINDOW_SECONDS),
                    version=numpy.array(ANALYZER_VERSION),
                )
                file.flush()
                os.fsync(file.fileno())
            # A job told to stop puts nothing in place.
            if stop is not None:
                raise_if_cancelled(stop)
            os.replace(temp, name, src_dir_fd=folder, dst_dir_fd=folder)
        except BaseException:
            try:
                os.unlink(temp, dir_fd=folder)
            except OSError:
                pass
            raise
        return os.stat(name, dir_fd=folder, follow_symlinks=False).st_size
    finally:
        os.close(folder)


def decode_stereo(path: str, stop: threading.Event | None = None) -> tuple[Any, bool]:
    """At most the first MAX_SECONDS of a file as 16 bit stereo (2, n), and whether the
    file is longer. The samples stay 16 bit: half of what floats would take."""
    import numpy

    # One second more than is kept tells a file that goes on.
    samples = _samples_of_wav(decode_wav(path, 2, MAX_SECONDS + 1, stop, DECODE_TIMEOUT_S))
    interleaved = numpy.frombuffer(samples, dtype="<i2", count=len(samples) // 2)
    audio = interleaved.reshape(-1, 2).T
    kept = MAX_SECONDS * SAMPLE_RATE
    return audio[:, :kept], audio.shape[1] > kept


def separate_file(path: str, track_id: int, stop: threading.Event) -> dict[str, Any]:
    """Runs in the Demucs worker: decodes, separates and writes one track's envelopes."""
    stems_dir()
    name = envelope_name(track_id)
    started = time.monotonic()
    try:
        raise_if_cancelled(stop)
        try:
            audio, truncated = decode_stereo(path, stop)
        except ToolStopped:
            raise JobCancelled() from None
        # Before the model is loaded, which takes seconds the first time.
        raise_if_cancelled(stop)
        if audio.shape[1] < MIN_SECONDS * SAMPLE_RATE:
            raise ValueError("the audio is too short to separate")
        duration = audio.shape[1] / SAMPLE_RATE
        envelopes = envelopes_of(audio, demucs_separator(load_model()), stop)
        del audio
        raise_if_cancelled(stop)
        size = write_envelopes(name, envelopes, stop)
    finally:
        free_device_memory()
    seconds = time.monotonic() - started
    logger.info("stems of track %s: %d windows in %.1f s", track_id, envelopes.shape[1], seconds)
    return {
        "file": name,
        "frames": int(envelopes.shape[1]),
        "bytes": int(size),
        "seconds": round(seconds, 2),
        "durationSeconds": round(duration, 2),
        "truncated": bool(truncated),
        "analyzerVersion": ANALYZER_VERSION,
    }


@rpc("analysis.stems")
def stems(path: str, track_id: int, job_id: str) -> dict[str, Any]:
    """Separate one file and keep its stems as envelopes. Reads the file, writes the envelopes."""
    if not isinstance(path, str) or not os.path.isabs(path):
        raise ValueError("path must be an absolute path")
    envelope_name(track_id)
    with cancellable(job_id) as stop:
        raise_if_cancelled(stop)
        future = server.demucs_executor().submit(separate_file, path, track_id, stop)
        # A job told to stop answers at once; the worker, which cannot be interrupted
        # inside a minute of audio, ends after the one it is in and writes nothing.
        while not wait([future], timeout=_POLL_S).done:
            if stop.is_set():
                future.cancel()
            raise_if_cancelled(stop)
        return future.result()
