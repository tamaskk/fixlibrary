---
paths:
  - 'src/main/services/file-ops.ts'
  - 'src/main/pipeline/**'
  - 'python/fixlib_py/tags.py'
  - 'python/fixlib_py/convert.py'
  - 'python/fixlib_py/normalize.py'
---

# Library file safety

The user's music files are irreplaceable. These rules have no exceptions.

- Two phases. Compute may read files and write to the database and cache; it never modifies, moves, renames or deletes a library file. Apply runs only after the user approved the batch preview.
- Every modification goes through `src/main/services/file-ops.ts`. Python functions that write audio or tags receive an explicit target path from it; they never choose one.
- In-place mode: copy the original to the backup folder and record it in `backups` before the first change to that track.
- Clean library mode: copy first, then work only on the copy. The original's bytes never change.
- Atomic writes: write to `.<name>.fixlib-tmp` in the same folder, then rename. Never write into the final path directly.
- Never overwrite an existing different file: on a name collision append ` (2)`, ` (3)` and raise a `NAME_COLLISION` warning.
- Check free space before a batch; refuse to start if backups or copies would not fit.
- Deleting a library file is done only by undo (files the batch created) and by an explicit user choice in the duplicates view. Nothing else deletes.
- Excluded rows and fields in `locked_fields` are never written.
- Every file-op change needs a test that proves it with sha256: untouched files stay identical, undo restores byte-identical originals.
- While developing, run file operations only against temp directories or `tests/fixtures/synthetic/`.
