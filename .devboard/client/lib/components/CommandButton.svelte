<script lang="ts">
  import Button, { type ButtonProps } from "./ui/button.svelte";
  import CommandNotice from "./CommandNotice.svelte";
  import { createCommandBusy } from "../command-busy.svelte";

  interface Props
    extends Omit<ButtonProps, "busy" | "busyLabel" | "onclick" | "label" | "command"> {
    /** The resting visible label; its present participle is the busy word. */
    label: string;
    /** Reactive read of the server state that confirms the command. */
    evidence: () => unknown;
    /** Reactive read of the subject; a reused control never carries another's latch. */
    scope?: () => unknown;
    /**
     * Dispatches the WebSocket command once per activation. Returns false when
     * it refused locally and sent nothing: the control then shows no busy word
     * and no ceiling notice, because no answer was ever asked for.
     */
    command: () => boolean | void;
    /** Exact busy phrase, for a control whose label is a phrase. */
    busyLabel?: string;
  }

  let { label, evidence, scope, command, busyLabel, children, ...rest }: Props = $props();

  const pending = createCommandBusy({
    label: () => label,
    evidence: () => evidence(),
    scope: () => scope?.(),
  });

  function activate(): void {
    pending.start();
    // The baseline is captured before dispatch so an immediate answer is never
    // missed; a refused dispatch releases the latch in the same activation.
    if (command() === false) pending.refuse();
  }
</script>

<!-- Composes the one button primitive with its in-flight state and ceiling
     notice; it renders no button of its own. The caller's content is forwarded
     as the primitive's `children`, so a control with no content of its own
     still shows its resting label. -->
<Button
  {...rest}
  {label}
  busyLabel={busyLabel}
  busy={pending.busy}
  onclick={activate}
  children={children}
/>
{#if pending.notice !== null}
  <CommandNotice text={pending.notice} ondismiss={() => pending.dismiss()} />
{/if}
