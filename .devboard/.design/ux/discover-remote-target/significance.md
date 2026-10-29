# Discover remote target — significance

Significance is set by what an operator must read before trusting the Discover sheet. The remote
panel is first in the Overview and names the repository every other region is showing.

## P0 — the target itself

- `region_toolbar` (the retained-project dropdown) is the only control that changes the active
  target. Its label and 28px height match the shipped input scale.
- `region_list` states which retained project is active with the shipped accent-row grammar and
  one `Active` word; the URL itself is mono, matching every other identifier in the console.
- `region_add` is the only way to introduce a project; its visible label and `surface-raised`
  band separate it from switching and remove it from the old unlabeled form line.

## P1 — context and exit

- The header count (`<n> retained`) tells the operator how many projects the list holds without
  counting rows.
- `Clear remote target` in the panel footer is the return to this checkout. It never sits beside
  the add submit, so returning is not mistaken for adding or deleting.
- Each row's `Remove` is quiet by default and turns `error` only on its own hover or focus; the
  active row keeps its own remove control, and colour never carries the destructive meaning alone
  because the word says `Remove`.

## P2 — transient states

- The cloning line names the URL while a clone runs; it is the only row that appears without a
  retained project.
- The header count and footer appear and disappear with their state; they never reserve an empty
  line.

No permanent danger zone, confirmation, or empty panel is added: removing a retained project is
one row action, and the empty retained state is the add band with no extra copy.
