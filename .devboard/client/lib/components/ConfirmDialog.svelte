<script lang="ts">
  import { Dialog } from "bits-ui";
  import Button from "./ui/button.svelte";

  interface Props {
    open: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel?: string;
    destructive?: boolean;
    testid?: string;
    confirmCommand?: string;
    cancelCommand?: string;
    onconfirm: () => void;
    oncancel: () => void;
  }

  let {
    open,
    title,
    message,
    confirmLabel,
    cancelLabel = "Cancel",
    destructive = false,
    testid,
    confirmCommand,
    cancelCommand,
    onconfirm,
    oncancel,
  }: Props = $props();
</script>

<Dialog.Root {open} onOpenChange={(value) => { if (!value) oncancel(); }}>
  <Dialog.Portal>
    <Dialog.Overlay class="dialog-overlay" />
    <Dialog.Content class="dialog-content" data-testid={testid} aria-label={title}>
      <div class="dialog-header">
        <Dialog.Title class="dialog-title">{title}</Dialog.Title>
      </div>
      <div class="dialog-body">
        <Dialog.Description class="muted text-[12px]">{message}</Dialog.Description>
      </div>
      <div class="dialog-footer">
        <Button
          variant="outline"
          data-command={cancelCommand}
          onclick={oncancel}
        >
          {cancelLabel}
        </Button>
        <Button
          variant={destructive ? "destructive" : "default"}
          data-command={confirmCommand}
          onclick={onconfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
