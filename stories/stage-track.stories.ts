import type { Meta, StoryObj } from "@storybook/svelte";
import StageTrackDemo from "./StageTrackDemo.svelte";

const meta = {
  title: "Design System/StageTrack",
  component: StageTrackDemo,
  parameters: { layout: "fullscreen" },
  argTypes: {
    stage: {
      control: "select",
      options: ["goal", "epic", "adr", "implementation", "finished"],
    },
    pass: { control: { type: "number", min: 1 } },
  },
} satisfies Meta<typeof StageTrackDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

// A fresh host: the server has not reported a stage, so nothing claims progress.
export const NotStarted: Story = {
  args: { stage: "goal", pass: 1, seen: false, workLabel: null },
};

// The lifecycle is resolving ADRs in its second pass with a concrete work item.
export const Running: Story = {};

// Paused: the state word changes and resume is the page's next action.
export const Paused: Story = { args: { paused: true } };

// A manual run outside the lifecycle: the state word distinguishes it from lifecycle work.
export const ManualRun: Story = {
  args: { seen: false, manual: true, workLabel: "0003-ledger-schema.md" },
};

// Finished: every stage is complete and the work item is cleared.
export const Finished: Story = {
  args: { stage: "finished", pass: 2, workLabel: null },
};

// A narrow workspace: stage labels stay on one line and the work item wraps.
export const Narrow: Story = {
  args: { narrow: true, workLabel: "0003-append-only-event-ledger-schema-with-migrations.md" },
};
