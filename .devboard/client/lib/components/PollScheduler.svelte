<script lang="ts">
  import { connection } from "../connection.svelte";
  import { pollClaims } from "../poll-plan";

  // The one plan of reads the surfaces on screen claim, recomputed whenever
  // the mode, the active tab, or a shown run changes. The connection store's
  // scheduler is the only timer that acts on it: a surface that closes stops
  // being claimed here and is never read again.
  $effect(() => {
    connection.setSurfaceClaims(pollClaims());
  });
</script>
