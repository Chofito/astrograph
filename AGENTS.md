# Astrograph agent contract

This file is the provider-neutral entry point for Codex, Claude Code, Cursor,
OpenCode, Grok, and other coding or review harnesses working in this repository.
Keep provider-specific configuration as a thin adapter; project truth lives in
tracked Markdown and source.

## Start here

Read only the branch needed for the task:

- Product scope, release order, and non-goals: `ROADMAP.md`.
- Public types and tool behavior: `docs/contracts.md`.
- Architecture navigation and source-of-truth precedence:
  `docs/architecture/README.md`.
- Current implementation gaps: `docs/architecture/deviations.md`.
- A change to an existing subsystem: follow
  `docs/architecture/documentation-checklist.md` to its canonical owner.
- A review of AG-301 through AG-309: use
  `docs/architecture/operations/0.1-c-cross-model-review.md`.
- A code-architecture, dependency, call-flow, or impact question: read
  `agents/astrograph/SKILL.md` and check `astrograph status` before trusting the
  local graph.

Do not preload the full documentation tree. Follow the pointers above, then
open only the ticket, subsystem, code, fixture, or evidence paths relevant to
the current question.

## Authority and evidence

Use this precedence when sources disagree:

1. `ROADMAP.md` for product and release scope.
2. `docs/contracts.md` and accepted ADRs for public and architectural contracts.
3. Canonical architecture documents for AS-IS implementation claims.
4. Source, fixtures, persisted goldens, and recorded command output as evidence.
5. Review notes and `docs/todo/*.local.md` as context to verify, never proof.

Plans, tests committed to source, and earlier model verdicts do not prove that a
behavior passed. Distinguish static inspection, agent-reported execution, and
owner-run evidence in every completion claim. Tests and benchmarks are run by
the user; write or inspect them, provide exact commands, and wait for the user to
return the results before recording a gate as verified.

## Scope guardrails

- Astrograph indexes codebases. JS/TS and PHP are the `v0.1.0` languages.
- LLM features and PDF/Markdown/document ingestion are outside the Astrograph
  `0.1` and `0.2` roadmap. Document intelligence belongs to the separate
  AstroDocs product unless the maintainer explicitly changes that decision.
- `v0.1.0` is a public preview for single-application repositories. It does not
  include monorepos, Magento XML/DI/plugins, or another language.
- `v0.2.0` remains code intelligence: scale, incremental work, monorepos,
  Magento-aware semantics, real-task evaluation, and a Python backend. Later
  language order is Go, Kotlin, Swift, then Rust.
- Treat CodeGraph and Graphify as read-only references. Adopt validated
  invariants and methods, not their feature breadth or topology by default.
- Preserve the 0.1-C production oracle before optimizing memory, CPU, deltas,
  workers, caches, or lifecycle.

Questions that would change product scope, public compatibility, acceptance
criteria, or architecture ownership require an explicit maintainer decision.
Record the question instead of silently choosing an answer.

## Working rules

- Inspect `git status --short` and the relevant diff before editing. Preserve
  unrelated user changes.
- Use `rg`/`rg --files` for literal discovery and Astrograph for indexed JS/TS
  structural questions.
- Keep changes inside the requested ticket or review boundary.
- Update the canonical documentation owner in the same change as behavior.
- Use the existing test, fixture, and golden conventions; normal test execution
  must never rewrite goldens.
- Keep private repositories, graph databases, business symbols, and raw private
  transcripts out of prompts and committed evidence. Use synthetic fixtures or
  sanitized aggregate artifacts.
- Use the model or harness requested by the maintainer for delegated work. Do
  not use Caveman or Cavecrew workflows in this project.

