# Issue draft template

The visible part of an issue should be readable in two minutes (aim for ~5KB). The full design
goes in a collapsed section so implementers have it without wading through it. The draft's
`title` and `body` are separate fields; the block below shows the title as a heading only for
illustration and the body starts after it.

Title: conventional-commit style, e.g. `fix(worker): <what goes wrong, in user terms>`.

```markdown
# fix(<scope>): <what goes wrong>

**Severity:** high | medium | low · **Evidence:** reproduced | verified | static
**Findings:** F04 (F07) · **Found at:** <sha7> · **Lands after:** #F03

## Problem
Two to five sentences: what happens, who hits it, what they see.

## Reproduction
The failing test (name, file, command) or the manual recipe. For static evidence, say what to
check first before implementing.

## Fix
Three to eight bullets: the chosen approach and the main code changes.

## Acceptance
- [ ] The reproduction test passes.
- [ ] <behavioral checks>
- [ ] No `//nolint` added.

## Related
- #F05: <how it relates>
- owner/repo#82: <how it relates>

<details>
<summary>Design detail</summary>

### Mechanism
### Sequence / flow diagrams
(mermaid)
### Code changes
(snippets per file)
### Systemic consequences
### Shared contract items this issue implements
### Alternatives considered
### Open questions

</details>
```
