---
name: effect
description: Work with Effect v4 / effect-smol TypeScript code in this repo
---

# Effect

This codebase uses Effect for typed, composable TypeScript services, schemas, and workflows.

## Source Of Truth

Use the current Effect v4 / effect-smol source, not memory or older Effect v2/v3 examples.

1. Inspect existing repo code and installed dependency sources for the exact APIs, examples, tests, and naming patterns used by this project's Effect version.
2. If `.opencode/references/effect-smol` already exists, use it when its revision matches the dependency. Consult upstream source when local evidence is insufficient; create a checkout only when needed for the requested work and within its authorized scope. Loading this skill alone does not request a clone or project changes.
3. Follow the existing repo's local house style before introducing new patterns.
4. Prefer answers and implementations backed by specific source files or nearby repo examples.

## Guidelines

- Prefer current Effect v4 APIs and project-local patterns over old blog posts, examples, or package-memory guesses.
- Use `Effect.gen(function* () { ... })` for multi-step workflows.
- Use `Effect.fn("Name")` or `Effect.fnUntraced(...)` for named effects when adding reusable service methods or important workflows.
- Prefer Effect `Schema` for API and domain data shapes. Use branded schemas for IDs and `Schema.TaggedErrorClass` for typed domain errors when modeling new error surfaces.
- Keep HTTP handlers thin: decode input, read request context, call services, and map transport errors. Put business rules in services.
- In Effect service code, prefer Effect-aware platform abstractions and dependencies over ad hoc promises where the surrounding code already does so.
- Keep layer composition explicit. Avoid broad hidden provisioning that makes missing dependencies hard to see.
- In tests, prefer the repo's existing Effect test helpers and live tests for filesystem, git, child process, locks, or timing behavior.
- Do not introduce `any`, non-null assertions, unchecked casts, or older Effect APIs just to satisfy types.
- Do not answer from memory. Verify against `.opencode/references/effect-smol` or nearby code first.

## Testing Patterns

- Use `testEffect(...)` from `packages/opencode/test/lib/effect.ts` for tests that exercise Effect services, layers, runtime context, scoped resources, or platform integrations.
- Use `it.live(...)` for filesystem, git repositories, HTTP servers, sockets, child processes, locks, real time, and other live platform behavior.
- Run tests from package directories such as `packages/opencode`; never run package tests from the repo root.
- Prefer explicit test layers over ad hoc managed runtimes. Keep dependency provisioning visible in the test file.
- Use scoped fixtures and finalizers for resources that must be cleaned up, including temporary directories, flags, databases, fibers, servers, and global state.
