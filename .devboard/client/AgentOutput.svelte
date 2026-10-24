<script lang="ts">
  import DOMPurify from "dompurify";
  import { marked } from "marked";

  marked.use({ gfm: true, breaks: true });

  let { text }: { text: string } = $props();

  let html = $derived(DOMPurify.sanitize(marked.parse(text) as string));
</script>

<div class="agent-output">{@html html}</div>
