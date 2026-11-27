# AI-SDD Document Model Migration (v4.x -> v5.x)

## Pending Items

This project still holds 1 persisted design document(s) under `.sdd/specification/`:

- `.sdd/specification/touryou_design.md`

## What This Means

These files remain valid: read them as supplementary input, and do not treat
them as naming violations. Since v5.0.0 a technical design starts as a temporary
draft at `.sdd/task/{ticket-number}/design-draft.md` and is deleted
after implementation; only the decisions worth keeping are appended to
`.sdd/adr/{feature-name}.md`. Moving each file's decision history
there is human-paced and can be done feature by feature - nothing breaks until it
is; keep the original until that is done.

## Where the Steps Are

Open `/Users/toshiki.imagawa/work/comcreate/.claude-home/plugins/cache/ai-sdd-workflow/sdd-workflow/5.3.2/README.md` and read the section
"Extracting Existing `*_design.md` Files into `adr/`" under "Migration from v4.x".
The same section in `README.ja.md`, next to it, is the Japanese version.

---
This file is regenerated at every session start while such documents exist, and
is deleted automatically once none are left. It is a generated list, so edits to
it do not survive the next session.
