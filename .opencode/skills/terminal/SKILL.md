---
name: terminal
description: Choose platform-compatible commands when OS, shell, or process lifecycle affects CLI work.
metadata:
  version: "3"
---

# Shell and process behavior

The tool name `bash` does not establish the host OS or actual shell. Check the
environment, installed executables, path syntax, quoting, and exit status before
relying on platform-specific commands. Choose command structure that makes
inputs, outputs, and failures clear.

For a long-running process, distinguish successful startup from completed
work and use the session controls actually exposed. Keep the lifecycle and
cleanup clear for processes you start. When a command or tool reports an error,
use the observed details to choose the next step that serves the user's request.
