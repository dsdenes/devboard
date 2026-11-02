<script lang="ts">
  import { connection } from "../connection.svelte";
  import { devboard } from "../devboard.svelte";
  import PageHeader from "./ui/page-header.svelte";

  const count = $derived(devboard.skills.length);

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
        </tr>
      </thead>
      <tbody>
        {#each devboard.skills as skill (skill.name)}
          <tr data-testid="skill-row" data-skill={skill.name}>
            <td class="skills-table__name">{skill.name}</td>
            <td class="skills-table__toggle">
              <input
                type="checkbox"
                data-testid="skill-enabled"
                checked={skill.enabled}
                aria-label={`${skill.name} enabled`}
                onchange={(event) => toggle(skill.name, event)}
              />
            </td>
          </tr>
        {:else}
          <tr>
            <td colspan="2" class="empty">
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
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    padding: 6px 12px;
    text-align: left;
    text-transform: uppercase;
  }

  .skills-table td {
    border-bottom: 1px solid var(--border-subtle);
    padding: 5px 12px;
  }

  .skills-table tbody tr:last-child td {
    border-bottom: 0;
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
    accent-color: var(--foreground);
    cursor: pointer;
    margin: 0;
    vertical-align: middle;
  }
</style>
