# Prepared skill detail — significance

`score = 20 × (0.35·goal + 0.25·action + 0.15·frequency + 0.15·unique + 0.10·risk)`

| ID | Information | Goal | Action | Freq | Unique | Risk | Score | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| C1 | Skill rows (name + description) | 5 | 5 | 5 | 4 | 1 | 89 | P0 | List above the document; selected row marked |
| C8 | Instructions body | 5 | 4 | 4 | 5 | 3 | 88 | P0 | The document panel, first screen when open |
| C3 | Contradiction warnings | 4 | 4 | 2 | 5 | 4 | 77 | P1 | Below the list, above the page's empty space |
| C5 | Selected skill name | 4 | 3 | 4 | 3 | 1 | 66 | P1 | Detail header |
| C2 | Prepared skill count | 2 | 2 | 4 | 1 | 1 | 41 | P2 | Panel and page headers |
| C7 | File path | 3 | 3 | 2 | 4 | 1 | 56 | P2 | Detail header, truncated before the name |
| C4 | No-contradiction line | 3 | 2 | 2 | 3 | 1 | 48 | P2 | One muted line |
| C10–C12 | Empty, metadata-only, disconnected | 2 | 3 | 1 | 4 | 2 | 47 | P2 | In place of the document when it cannot render |
| C6 | Description in the detail | 2 | 1 | 3 | 0 | 0 | 27 | P3 | Drop: duplicate of C1 |
| C9 | YAML frontmatter | 0 | 0 | 3 | 0 | 0 | 9 | Drop | Remove |

## Ordering after scoring

1. **Instructions (C8):** the only P0 that the element itself owns; it takes every vertical pixel
   left after the list and scrolls internally.
2. **Name (C5) and path (C7):** a 30px header identifies the document and where it lives.
3. **List (C1):** P0 for the page, but a supporting selector for the document; it caps at 40% of
   the page height while a document is open and owns its own scroll.
4. **Contradictions (C3):** stay inside the list panel; the audit result is not repeated in the
   document header.
5. **Description (C6) and frontmatter (C9):** removed.
