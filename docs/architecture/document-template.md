# Architecture document template

Status: current
Baseline: `8c6e9ad004a491886fb396cddca0dd617c67f495`
Canonical owner: architecture documentation

Use this shape for new architecture documents. Remove instructions, not required headings.

```markdown
# Title

Status: Current | Target | Mixed
Baseline: <commit SHA>
Canonical owner: <subsystem>

## Purpose
## Boundaries and responsibilities
## Current behavior (AS-IS)
## Source evidence
## Target behavior (TO-BE)
## Invariants
## Main flow
## Failure and partial states
## Reusable vs specific parts
## Known deviations
## Related documents
```

An AS-IS statement must cite a path or symbol. A TO-BE statement must cite `ROADMAP.md`, `docs/contracts.md`, an accepted ADR, or an approved spec. If a section does not apply, state that explicitly rather than leaving its status ambiguous.

