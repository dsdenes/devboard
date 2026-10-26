import type { Meta, StoryObj } from "@storybook/svelte";
import DesignSystemOverview from "./DesignSystemOverview.svelte";

const meta = {
  title: "Design System/Overview",
  component: DesignSystemOverview,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof DesignSystemOverview>;

export default meta;
type Story = StoryObj<typeof meta>;

// Projection of DESIGN.md through design/tokens.json. The component reads the DTCG file and
// renders colors, type scale, spacing, and radii; it renders no product component.
export const Overview: Story = {};
