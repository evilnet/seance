# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase. This is a **single-context** repo.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root: **this repo's glossary.** Where a skill says `GLOSSARY.md`, read and write `CONTEXT.md` instead — it is referenced by that name from `CLAUDE.md` and `docs/`, so don't create a separate `GLOSSARY.md` or rename it.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.
- The design records under **`docs/projects/`** and the reference notes under **`docs/resources/`** (see `docs/README.md`) carry most of the decisions made so far; read the ones for the area you're touching.

If `docs/adr/` doesn't exist yet, **proceed silently**. Don't flag its absence; don't suggest creating it upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates ADRs lazily when decisions actually get resolved, and adds terms to `CONTEXT.md` the same way.

## File structure

```
/
├── CONTEXT.md          ← the glossary
├── docs/adr/
│   └── 0001-….md
├── docs/projects/      ← plans and design records
├── docs/resources/     ← reference notes
└── client/, shared/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids (its `_Avoid_:` lines).

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR (or a decision recorded in a `docs/projects/` design record), surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (…), but worth reopening because…_
