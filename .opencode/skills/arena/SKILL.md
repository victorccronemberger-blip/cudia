---
name: arena
description: Run four independent candidates and select the strongest evidence-based result when the operator explicitly asks for Arena or a four-agent competition.
---

# Arena

Use this workflow for an explicit Arena request, including `/arena <objective>`.
Prepare one compact briefing from the operator's objective, constraints, shared
evidence, and requested output. Give all four candidates the identical briefing
and acceptance criteria. Evaluate correctness against the objective first,
then evidence and verification, then simplicity and fit to the requested format.
Include only context needed for the task.

Launch four independent candidates using the delegation capabilities available
in the session: use the native `task` tool with `subagent_type: "arena-contestant"`,
inheriting the coordinator's model and variant. Omit `task_id` to create a fresh
conversation for each candidate. When supported, submit the identical briefing to all four
concurrently and use distinct short descriptions to identify them. Otherwise,
run them sequentially with the same original briefing.

Candidates can share a workspace. For work that edits files, use independent
scratch areas or worktrees when available. If isolation is unavailable, run the
candidates sequentially to avoid conflicting writes. Use the tools available in
the session for the work.

Collect the four outcomes before selecting. Treat failed or missing outcomes as
missing evidence. Compare each result against the briefing's criteria; agreement
or confidence alone does not establish correctness. Verify the strongest
plausible result against original evidence. For a requested code change, apply
the selected patch and run relevant checks. If it fails, assess the next result
against the same criteria.

Deliver the selected result with the evidence, checks, and limitations needed
to assess it. Focus the final report on the selected result; include comparisons
when they help assess the outcome or the operator requests them. If no result
satisfies the objective, state what remains unresolved. The selection is a
reasoned judgment, not a guarantee.
