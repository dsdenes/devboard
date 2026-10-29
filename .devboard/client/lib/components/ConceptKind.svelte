<script lang="ts">
  import Box from "lucide-svelte/icons/box";
  import Hash from "lucide-svelte/icons/hash";
  import Scale from "lucide-svelte/icons/scale";
  import Tag from "lucide-svelte/icons/tag";
  import UserCog from "lucide-svelte/icons/user-cog";
  import UserRound from "lucide-svelte/icons/user-round";
  import Zap from "lucide-svelte/icons/zap";

  interface Props {
    kind: string;
  }

  let { kind }: Props = $props();

  const ICONS = {
    actor: UserRound,
    entity: Box,
    event: Zap,
    field: Tag,
    role: UserCog,
    rule: Scale,
    value: Hash,
  } as const;

  const normalized = $derived(kind.trim().toLowerCase());
  const Icon = $derived(
    ICONS[normalized as keyof typeof ICONS] ?? Tag,
  );
</script>

<span class="discover-kind" data-kind={normalized} title={kind}>
  <Icon size={12} strokeWidth={1.7} aria-hidden="true" />
  <span>{kind}</span>
</span>

<style>
  .discover-kind {
    align-items: center;
    color: var(--muted-foreground);
    display: inline-flex;
    gap: 4px;
    white-space: nowrap;
  }
</style>
