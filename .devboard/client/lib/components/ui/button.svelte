<script lang="ts" module>
  import { tv, type VariantProps } from "tailwind-variants";

  export const buttonVariants = tv({
    base: "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-sm border text-[12px] font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--background)] disabled:pointer-events-none disabled:opacity-45",
    variants: {
      variant: {
        default:
          "border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)]",
        secondary:
          "border-[var(--border-strong)] bg-[var(--secondary)] text-[var(--foreground)] hover:bg-[var(--secondary-hover)]",
        outline:
          "border-[var(--border-strong)] bg-transparent text-[var(--foreground)] hover:bg-[var(--secondary)]",
        ghost:
          "border-transparent bg-transparent text-[var(--foreground)] hover:bg-[var(--secondary)]",
        destructive:
          "border-[var(--destructive)] bg-[var(--destructive)] text-[var(--destructive-foreground)] hover:opacity-90",
        link: "border-transparent bg-transparent text-[var(--primary)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-7 px-2.5",
        sm: "h-6 px-2 text-[11px]",
        icon: "size-7",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  });

  export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
  export type ButtonSize = VariantProps<typeof buttonVariants>["size"];
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";
  import { cn } from "../../utils";

  interface Props extends Omit<HTMLButtonAttributes, "class" | "children"> {
    variant?: ButtonVariant;
    size?: ButtonSize;
    class?: string;
    children?: Snippet;
  }

  let { variant = "secondary", size = "default", class: className = "", children, ...rest }: Props =
    $props();
</script>

<button
  type="button"
  data-slot="button"
  class={cn(buttonVariants({ variant, size }), className)}
  {...rest}
>
  {@render children?.()}
</button>
