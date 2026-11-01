<script lang="ts">
  import Check from "lucide-svelte/icons/check";
  import X from "lucide-svelte/icons/x";
  import { saveFeedback } from "../save-feedback.svelte";

  interface Props {
    /** Names the Save control this confirmation belongs beside. */
    scope: string;
  }

  let { scope }: Props = $props();
</script>

{#if saveFeedback.text !== null && saveFeedback.scope === scope}
  <div
    class="save-feedback"
    data-testid="save-feedback"
    data-scope={scope}
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    <span class="save-feedback__icon" aria-hidden="true">
      <Check size={14} />
    </span>
    <p class="save-feedback__text">{saveFeedback.text}</p>
    <button
      type="button"
      class="save-feedback__close"
      aria-label="Dismiss save confirmation"
      title="Dismiss"
      onclick={() => saveFeedback.dismiss()}
    >
      <X size={12} aria-hidden="true" />
    </button>
  </div>
{/if}

<style>
  /* Inline beside the Save control that produced it, inside that control's
     header or footer. It never leaves the owning surface. */
  .save-feedback {
    align-items: center;
    animation: save-feedback-in 120ms ease-out;
    background: var(--surface-raised);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    color: var(--foreground);
    display: inline-flex;
    flex: 0 0 auto;
    gap: 6px;
    max-width: min(320px, 100%);
    padding: 2px 8px;
  }

  .save-feedback__icon {
    color: var(--success);
    display: flex;
  }

  .save-feedback__text {
    font-size: 11px;
    font-weight: 600;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .save-feedback__close {
    align-items: center;
    background: none;
    border: 0;
    color: var(--muted-foreground);
    cursor: pointer;
    display: flex;
    padding: 1px;
  }

  .save-feedback__close:hover {
    color: var(--foreground);
  }

  @keyframes save-feedback-in {
    from {
      opacity: 0;
      transform: translateY(2px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .save-feedback {
      animation: none;
    }
  }
</style>
