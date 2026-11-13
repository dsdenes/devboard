<script lang="ts">
  import { Tooltip } from "bits-ui";
  import ActivityBar from "./ActivityBar.svelte";

  // The app root's tooltip provider: the rail's tooltip parts require it, and a
  // test renders the rail the way App.svelte does.
</script>

<Tooltip.Provider>
  <ActivityBar
    onopenpalette={() => {}}
    onreportissue={() => {}}
    onremoveelement={() => {}}
    onredesignelement={() => {}}
    reportphase="idle"
    reportaction={null}
    feedbackenabled={false}
  />
</Tooltip.Provider>
