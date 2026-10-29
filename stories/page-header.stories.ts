import type { Meta, StoryObj } from "@storybook/svelte";
import PageHeaderDemo from "./PageHeaderDemo.svelte";

const meta = {
  title: "Design System/PageHeader",
  component: PageHeaderDemo,
  parameters: { layout: "fullscreen" },
  argTypes: {
    actionCount: { control: { type: "range", min: 0, max: 4, step: 1 } },
  },
} satisfies Meta<typeof PageHeaderDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

// The default page identity: eyebrow, one h1, a state subtitle, one meta line, three actions.
export const Default: Story = {};

// A long title truncates with a tooltip instead of wrapping or pushing the actions.
export const LongTitle: Story = {
  args: {
    title: "Decision records for the append-only event ledger rewrite and its migrations",
  },
};

// No meta line: the page has no status to state under the subtitle.
export const WithoutMeta: Story = { args: { meta: false } };

// Many actions wrap; the filled primary stays last.
export const ManyActions: Story = { args: { actionCount: 4 } };

// No actions: read-only pages such as an ADR detail without a pending start.
export const NoActions: Story = { args: { actionCount: 0 } };

// Flat inside a parent panel, as the Goal document page composes it.
export const FlatInsidePanel: Story = { args: { flat: true, actionCount: 3 } };

// The operational bar: the state cluster sits beside the action it qualifies.
export const Bar: Story = {
  args: {
    eyebrow: "Issues",
    title: "Auto Scout",
    subtitle: "dsdenes/devboard",
    layout: "bar",
    actionCount: 1,
  },
};

// The bar with its secondary footer band: controls that configure the primary
// action stay on the header surface, below the state and the action.
export const BarWithFooter: Story = {
  args: {
    eyebrow: "Issues",
    title: "Auto Scout",
    subtitle: "dsdenes/devboard",
    layout: "bar",
    footer: true,
    actionCount: 1,
  },
};
