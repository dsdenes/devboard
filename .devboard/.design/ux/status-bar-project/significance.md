# Significance — status bar project identity

Weights: goal 35%, action 25%, frequency 15%, uniqueness 15%, risk 10%.
`score = 20 × (0.35·goal + 0.25·action + 0.15·frequency + 0.15·unique + 0.10·risk)`

| ID | Information | Goal | Action | Freq | Unique | Risk | Score | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| P1 | Repository name (last path segment) | 5 | 3 | 4 | 5 | 3 | 83 | P0 | Present in the footer's first group |
| P3 | Connection state (dot plus word) | 4 | 3 | 5 | 5 | 4 | 81 | P0 | Present in the footer's first group, in its own item |
| P2 | Full path | 2 | 2 | 1 | 3 | 3 | 42 | P2 | Disclosure: the item's tooltip |
| P4 | Provider selection | 2 | 2 | 2 | 5 | 1 | 47 | P2 | Present as its own control, unchanged |
| P7 | Folder glyph | 1 | 0 | 4 | 2 | 0 | 25 | P3 | Retained anyway: at 11.5px the glyph is what makes the item scan as a repository rather than a stray word |

Deduplication:

- P1 and P2 are the same fact at two granularities. P1 stays visible, P2 stays on demand, so the
  footer never prints the path twice.
- P3 stays a separate item: it answers "is this live", not "which repository", and merging it into
  the project item would make one item carry two decisions.
- No vanity metric was retained; nothing displays a value the contract does not own.
