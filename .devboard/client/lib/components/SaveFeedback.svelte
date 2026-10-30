<script lang="ts">
  import Check from "lucide-svelte/icons/check";
  import X from "lucide-svelte/icons/x";
  import { saveFeedback } from "../save-feedback.svelte";
</script>

{#if saveFeedback.text !== null}
  <div
    class="save-feedback"
    data-testid="save-feedback"
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
  /* Bottom center, above the fixed notification region, and never in the way
     of the Save control itself. */
  .save-feedback {
    align-items: flex-start;
    animation: save-feedback-in 120ms ease-out;
    background: var(--surface-raised);
    border: 1px solid var(--border-strong);
    border-left: 3px solid var(--success);
    border-radius: 6px;
    bottom: 40px;
    color: var(--text);
    display: flex;
    gap: 8px;
    left: 50%;
    max-width: min(420px, calc(100vw - 32px));
    padding: 8px 10px;
    position: fixed;
    transform: translateX(-50%);
    z-index: 85;
  }

  .save-feedback__icon {
    color: var(--success);
    display: flex;
    margin-top: 1px;
  }

  .save-feedback__text {
    font-size: 12px;
    font-weight: 600;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .save-feedback__close {
    align-items: center;
    background: none;
    border: 0;
    color: var(--muted);
    cursor: pointer;
    display: flex;
    padding: 2px;
  }

  .save-feedback__close:hover {
    color: var(--text);
  }

  @keyframes save-feedback-in {
    from {
      opacity: 0;
      transform: translate(-50%, 6px);
    }
    to {
      opacity: 1;
      transform: translate(-50%, 0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .save-feedback {
      animation: none;
    }
  }
</style>
