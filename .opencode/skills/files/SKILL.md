---
name: files
description: Handle workspace edits involving path boundaries, symlinks, generated files, or existing changes.
metadata:
  version: "3"
---

# Workspace edits

Inspect applicable project instructions, existing changes, and path or symlink
destinations before editing. Preserve unrelated work, text encoding, and
newline style. Prefer bounded reads and small patches; inspect the resulting
diff and verify the actual write result.

For generated or binary files, identify the generator or format instead of
patching them as plain text. Use the file tools exposed in the session;
loading this skill supplies no checkpoints, software, or additional access.
