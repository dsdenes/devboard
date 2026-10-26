import type { Preview } from "@storybook/svelte-vite";
import "../client/app.css";

const preview: Preview = {
  parameters: {
    layout: "fullscreen",
  },
};

export default preview;
