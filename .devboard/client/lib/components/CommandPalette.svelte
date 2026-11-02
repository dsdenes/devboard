<script lang="ts">
  import { tick } from "svelte";
  import { Dialog } from "bits-ui";
  import { notifications } from "../notifications.svelte";
  import type { CommandDef } from "../commands";
  import Button from "./ui/button.svelte";

  interface Props {
    open: boolean;
    commands: CommandDef[];
    onclose: () => void;
  }

  let { open, commands, onclose }: Props = $props();

  let query = $state("");
  let activeIndex = $state(0);
  let input: HTMLInputElement | undefined = $state();
  let list: HTMLDivElement | undefined = $state();

  const filtered = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return commands;
    return commands.filter((command) => {
      const haystack = `${command.title} ${command.group} ${command.id} ${command.keywords ?? ""}`;
      return haystack.toLowerCase().includes(needle);
    });
  });

  const active = $derived(filtered[activeIndex]);

  function isDisabled(command: CommandDef | undefined): boolean {
    return command?.disabled?.() != null;
  }

  function reset(): void {
    query = "";
    activeIndex = 0;
  }

  function move(delta: number): void {
    if (filtered.length === 0) return;
    let index = activeIndex;
    for (let step = 0; step < filtered.length; step += 1) {
      index = (index + delta + filtered.length) % filtered.length;
      if (!isDisabled(filtered[index])) break;
    }
    activeIndex = index;
    queueMicrotask(() => {
      document
        .getElementById(`palette-item-${activeIndex}`)
        ?.scrollIntoView({ block: "nearest" });
    });
  }

  function edge(end: "start" | "end"): void {
    const enabled = filtered
      .map((command, index) => ({ command, index }))
      .filter((entry) => !isDisabled(entry.command));
    if (enabled.length === 0) return;
    activeIndex = edgeIndex(enabled, end);
  }

  function edgeIndex(
    enabled: Array<{ command: CommandDef; index: number }>,
    end: "start" | "end",
  ): number {
    return end === "start" ? (enabled[0]?.index ?? 0) : (enabled[enabled.length - 1]?.index ?? 0);
  }

  function run(command: CommandDef | undefined): void {
    if (command === undefined) return;
    const reason = command.disabled?.();
    if (reason != null) return;
    notifications.markRead();
    onclose();
    void Promise.resolve(command.run()).catch(() => {
      /* A command that cannot run reports through its surface. */
    });
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      edge("start");
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      edge("end");
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      run(active);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onclose();
    }
  }

  function onOpenChange(value: boolean): void {
    if (!value) onclose();
  }

  $effect(() => {
    if (open) {
      reset();
      void tick().then(() => input?.focus());
    }
  });

  $effect(() => {
    void filtered.length;
    if (activeIndex >= filtered.length) activeIndex = 0;
  });

</script>

<Dialog.Root {open} onOpenChange={onOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay class="dialog-overlay" />
    <Dialog.Content class="palette" data-testid="command-palette" aria-label="Command palette">
      <Dialog.Title class="sr-only">Command palette</Dialog.Title>
      <Dialog.Description class="sr-only">
        Search and run any Devboard command with the keyboard.
      </Dialog.Description>
      <div class="palette__search">
        <input
          bind:this={input}
          bind:value={query}
          class="h-7 w-full rounded-sm border border-[var(--border-strong)] bg-[var(--background)] px-2 text-[12px] text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)] focus-visible:border-[var(--ring)] focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-list"
          aria-autocomplete="list"
          aria-activedescendant={active === undefined ? undefined : `palette-item-${activeIndex}`}
          aria-label="Search commands"
          placeholder="Type a command…"
          data-testid="command-palette-input"
          {onkeydown}
        />
      </div>
      <div
        class="palette__list"
        id="command-palette-list"
        role="listbox"
        aria-label="Commands"
        bind:this={list}
      >
        {#if filtered.length === 0}
          <p class="palette__empty">No commands match “{query}”.</p>
        {:else}
          {#each filtered as command, index (command.id)}
            {@const disabledReason = command.disabled?.()}
            {#if index === 0 || filtered[index - 1]?.group !== command.group}
              <div class="palette__group">{command.group}</div>
            {/if}
            <Button
              bare
              id={`palette-item-${index}`}
              class="palette__item"
              role="option"
              aria-selected={index === activeIndex}
              aria-disabled={disabledReason != null}
              data-testid="command-item"
              data-command={command.id}
              onclick={() => run(command)}
              onmouseenter={() => {
                if (!isDisabled(command)) activeIndex = index;
              }}
            >
              <span class="palette__item-title">{command.title}</span>
              {#if disabledReason != null}
                <span class="palette__item-reason">{disabledReason}</span>
              {/if}
              {#if command.shortcut !== undefined}
                <kbd class="palette__shortcut">{command.shortcut}</kbd>
              {/if}
            </Button>
          {/each}
        {/if}
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
