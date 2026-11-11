# Brief — status bar project identity

- **Page identity:** the shell footer of the Devboard console (`/`), whose left group states the
  WebSocket connection and the repository the dashboard serves. Not a route of its own.
- **Primary goal:** an operator glancing at the footer can tell which repository this dashboard is
  attached to, and whether that attachment is live, without reading the sidebar. Observable success:
  the repository name is legible at 11–12px in a 26px strip and is never mistaken for a control.
- **Secondary goals:** none. The footer is ambient orientation; it must not compete with the
  workspace for attention.
- **Arrival context:** the operator has been in the dashboard for a while; the footer is read
  peripherally and on demand when a second dashboard or worktree is open. Urgency is low, but a
  wrong-project reading is expensive.
- **Relationship to other pages:** the sidebar names the full project path; the Issues, Goal, and
  Discover modes all operate on the same repository, so the footer's identity is the whole shell's
  identity. The footer sits under every mode.
- **User journeys:**
  1. *Confirm the attached repository.* Trigger: two dashboards are open. Steps: glance at the
     footer, read the project name beside the connection state. Success: the name matches the
     checkout being edited. Failure: a blank or truncated name; recovery: hover for the full path.
  2. *Confirm the dashboard is live while reading.* Trigger: an agent write is expected. Steps:
     read the connection word and dot, then the project name. Success: `Connected` beside the
     expected project. Failure: `Disconnected` with the last known project; recovery: reconnect
     through the existing socket retry.
  3. *Find the full path.* Trigger: the last path segment is ambiguous. Steps: hover the project
     item. Success: the tooltip names the whole path. Failure: none plausible.
- **Non-goals:** the footer does not switch repositories, browse the filesystem, or repeat the full
  path inline. It is not a navigation surface and gains no click action.
- **Assumptions:** the repository name is the last path segment, as the component already
  documents; the sidebar remains the place for the full path.
