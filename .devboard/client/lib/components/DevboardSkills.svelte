<script lang="ts">
  import ChevronRight from "lucide-svelte/icons/chevron-right";
  import Trash2 from "lucide-svelte/icons/trash-2";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { connection } from "../connection.svelte";
  import { devboard } from "../devboard.svelte";
  import { renderSkillDocument } from "../skill-document";
  import Button from "./ui/button.svelte";
  import PageHeader from "./ui/page-header.svelte";

  const count = $derived(devboard.skills.length);
  let expanded = $state<string[]>([]);
  /** The prepared skill whose deletion waits for the dialog's confirmation. */
  let deleteTarget = $state<string | null>(null);

  // The page reads when it opens and after a reconnect; the server pushes a
  // frame after every toggle. No watcher, poll, or start trigger is involved.
  $effect(() => {
    if (connection.open) devboard.requestSkills();
  });

  function toggle(name: string, event: Event): void {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    devboard.setSkillEnabled(name, input.checked);
  }

  function setExpanded(name: string, open: boolean): void {
    expanded = open ? [...expanded, name] : expanded.filter((entry) => entry !== name);
  }
</script>

<div class="mode-body" data-testid="devboard-workspace">
  <PageHeader title="Skills" layout="bar" testid="devboard-header">
    {#snippet meta()}
      <span class="devboard-count">
        {count}
        {count === 1 ? "skill" : "skills"}
      </span>
    {/snippet}
  </PageHeader>

  <section class="panel devboard-panel" aria-label="Installed skills">
    <table class="skills-table" data-testid="skills-table">
      <thead>
        <tr>
          <th scope="col">Skill</th>
          <th scope="col" class="skills-table__toggle">Enabled</th>
          <th scope="col" class="skills-table__actions" aria-label="Actions"></th>
        </tr>
      </thead>
      <tbody>
        {#each devboard.skills as skill (skill.name)}
          {@const open = expanded.includes(skill.name)}
          <tr
            class="skills-table__row"
            class:skills-table__row--open={open}
            data-testid="skill-row"
            data-skill={skill.name}
            tabindex="0"
            aria-expanded={open}
            onclick={(event) => {
              if ((event.target as HTMLElement).closest("button, input, a") !== null) return;
              setExpanded(skill.name, !open);
            }}
            onkeydown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setExpanded(skill.name, !open);
              }
            }}
          >
            <td class="skills-table__name">
              <Button
                bare
                class="skills-table__disclosure"
                data-testid="skill-disclosure"
                aria-expanded={open}
                aria-controls={open ? `devboard-skill-content-${skill.name}` : undefined}
                onclick={() => setExpanded(skill.name, !open)}
              >
                <span class="skills-table__chevron" class:skills-table__chevron--open={open}>
                  <ChevronRight size={12} aria-hidden="true" />
                </span>
                {skill.name}
              </Button>
              {#if skill.builtin}
                <span
                  class="skills-table__managed"
                  data-testid="skill-managed"
                  title="Shipped with Devboard and never deleted"
                >
                  Managed
                </span>
              {/if}
            </td>
            <td class="skills-table__toggle">
              <input
                type="checkbox"
                data-testid="skill-enabled"
                checked={skill.enabled}
                aria-label={`${skill.name} enabled`}
                onchange={(event) => toggle(skill.name, event)}
              />
            </td>
            <td class="skills-table__actions">
              {#if skill.deletable}
                <Button
                  bare
                  class="skills-table__delete"
                  data-testid="delete-skill"
                  data-name={skill.name}
                  aria-label={`Delete ${skill.name}`}
                  title={`Delete ${skill.name} from .omp/skills/`}
                  disabled={!connection.open}
                  onclick={() => (deleteTarget = skill.name)}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </Button>
              {/if}
            </td>
          </tr>
          {#if open}
            <tr
              class="skills-table__content-row"
              data-testid="skill-content-row"
              data-skill={skill.name}
            >
              <td colspan="3" class="skills-table__content-cell">
                <div
                  id={`devboard-skill-content-${skill.name}`}
                  class="skills-table__content"
                  data-testid="skill-content"
                  data-skill={skill.name}
                  role="region"
                  aria-label={`${skill.name} content`}
                >
                  {#if skill.content.trim().length === 0}
                    <p class="skills-table__empty">This skill's SKILL.md is empty.</p>
                  {:else}
                    <div class="skill__document" data-testid="skill-content-text">
                      {@html renderSkillDocument(skill.content)}
                    </div>
                  {/if}
                </div>
              </td>
            </tr>
          {/if}
        {:else}
          <tr>
            <td colspan="3" class="empty">
              {devboard.skillsLoaded
                ? "No skills are installed in .omp/skills."
                : "Loading the installed skills…"}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>
</div>

<ConfirmDialog
  open={deleteTarget !== null}
  title="Delete skill"
  message={deleteTarget === null
    ? ""
    : `Delete "${deleteTarget}" from .omp/skills/? Implementing agents will no longer read it.`}
  confirmLabel="Delete skill"
  destructive
  testid="delete-skill-confirmation"
  confirmCommand="devboard.skills.delete.confirm"
  cancelCommand="devboard.skills.delete.cancel"
  evidence={() => devboard.skills}
  onconfirm={() => {
    if (deleteTarget !== null) devboard.deleteSkill(deleteTarget);
    deleteTarget = null;
  }}
  oncancel={() => (deleteTarget = null)}
/>

<style>
  .devboard-count {
    color: var(--muted-foreground);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .devboard-panel {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .skills-table {
    border-collapse: collapse;
    font-size: 12px;
    width: 100%;
  }

  .skills-table th {
    border-bottom: 1px solid var(--border);
    color: var(--muted-foreground);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.03em;
    line-height: 1.3;
    padding: 5px 8px;
    text-align: left;
    text-transform: uppercase;
  }

  .skills-table td {
    border-bottom: 1px solid var(--border-subtle);
    padding: 5px 8px;
  }

  .skills-table tbody tr:last-child td {
    border-bottom: 0;
  }

  .skills-table__row {
    cursor: pointer;
  }

  .skills-table__row:hover,
  .skills-table__row:focus-visible {
    background: var(--row-hover);
  }

  .skills-table__row:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: -2px;
  }

  .skills-table__chevron {
    color: var(--muted-foreground);
    display: inline-flex;
    transition: transform 120ms ease;
  }

  .skills-table__chevron--open {
    transform: rotate(90deg);
  }

  .skills-table__content-cell {
    background: var(--surface);
    padding: 0;
  }

  .skills-table__content {
    border-top: 1px solid var(--border-subtle);
    max-height: 320px;
    overflow: auto;
    padding: 10px 12px 12px 28px;
  }

  .skills-table__empty {
    color: var(--muted-foreground);
    margin: 0;
  }

  .skills-table__name {
    color: var(--foreground);
    font-family: var(--font-mono);
  }

  .skills-table__toggle {
    width: 1%;
    white-space: nowrap;
  }

  .skills-table__toggle input {
    accent-color: var(--accent);
    cursor: pointer;
    margin: 0;
    vertical-align: middle;
  }

  .skills-table__managed {
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    color: var(--muted-foreground);
    font-family: var(--font-sans);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    line-height: 1.2;
    margin-left: 8px;
    padding: 1px 6px;
    text-transform: uppercase;
    vertical-align: middle;
  }

  .skills-table__actions {
    text-align: right;
    white-space: nowrap;
    width: 1%;
  }

  :global(.skills-table__delete) {
    background: none;
    border: 0;
    border-radius: 3px;
    color: var(--muted-foreground);
    cursor: pointer;
    padding: 2px 4px;
    vertical-align: middle;
  }

  :global(.skills-table__delete:hover) {
    background: var(--error-surface);
    color: var(--destructive);
  }
</style>
