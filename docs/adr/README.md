# Architecture decision records

Short records of the decisions that shaped stampfill, in the order they were taken. Each one states
the context, the decision and its consequences; superseded records stay here with a note.

| # | Decision |
| --- | --- |
| [0001](0001-single-file-no-framework.md) | One source file, no web framework, no build step |
| [0002](0002-json-file-storage.md) | A JSON file and the filesystem instead of a database |
| [0003](0003-stamp-text-not-form-fields.md) | Stamp text onto the page instead of filling PDF form fields |
| [0004](0004-ipp-and-cups.md) | Print over IPP directly, convert through CUPS when needed |
| [0005](0005-stateless-signed-cookies.md) | Stateless HMAC cookies for the admin session and document unlocks |
| [0006](0006-prefill-in-the-browser.md) | Personal prefill values and signatures stay in the user's browser |
| [0007](0007-in-process-migrations.md) | Stored data is upgraded by one in-process migration step with a fixture test |
| [0008](0008-random-links-by-default.md) | Links are random by default; readable names and passwords are opt-in |
| [0009](0009-coverage-of-inline-scripts.md) | The browser suite measures coverage of the inline page scripts itself |

Adding a record: copy the template below into `NNNN-short-title.md`, add a row here, and link it
from `docs/design.md` where the decision matters.

```markdown
# NNNN. Title

Date: YYYY-MM-DD · Status: accepted | superseded by NNNN

## Context
## Decision
## Consequences
```
