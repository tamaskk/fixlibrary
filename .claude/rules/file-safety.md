---
paths:
  - 'src/main/services/file-ops.ts'
  - 'src/main/pipeline/**'
  - 'python/fixlib_py/tags.py'
  - 'python/fixlib_py/convert.py'
  - 'python/fixlib_py/tag_write.py'
  - 'python/fixlib_py/safe_files.py'
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
- Deleting a library file is done only by undo (files the batch created), by an explicit user choice in the duplicates view, and by a format conversion (`TrackFiles.convertTo`), which removes the old file once the new one is in place. Nothing else deletes.
- One more deletion, approved by the owner with T-022: when a file is moved into its style folder (`TrackFiles.organize`), the folders it left that hold nothing but Finder's `.DS_Store` go, that file with them (`FileOps.removeFolderOfFinderData`). Never the root, a style folder, or a folder of the app's own (`_Duplicates`, the backup folder, `Inbox`); a folder that holds anything else stays. The removal is best effort and never fails the move: it follows no link and checks the folder is the same one before removing. Undo puts the files back and makes their folders again; the `.DS_Store` is Finder's to make again. Undo also removes a style folder it leaves with nothing but a `.DS_Store`, that file with it; a folder of the app's own it removes only when empty.
- A conversion removes the old file only while every byte of it is in another file: its backup in the backup folder, or the original of a clean library copy. That is compared byte for byte before the conversion, again before the new file gets its name, and immediately before the old file is removed, also when a later attempt removes what an interrupted one left. If it does not hold, the old file stays.
- Excluded rows and fields in `locked_fields` are never written.
- Every file-op change needs a test that proves it with sha256: untouched files stay identical, undo restores byte-identical originals.
- While developing, run file operations only against temp directories or `tests/fixtures/synthetic/`.
