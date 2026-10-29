<script lang="ts">
  import { onMount } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import { layout } from "../layout.svelte";

  interface Props {
    lines: string[];
    "data-testid": string;
    label: string;
    class?: string;
  }

  let {
    lines,
    "data-testid": testid,
    label,
    class: className = "",
  }: Props = $props();

  let host: HTMLDivElement;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let rendered: string[] = [];
  let stick = true;

  const MONO_FONT =
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

  function palette(): Record<string, string> {
    const styles = getComputedStyle(document.documentElement);
    const token = (name: string): string => styles.getPropertyValue(name).trim();
    return {
      background: token("--background"),
      foreground: token("--foreground"),
      cursor: token("--accent"),
      selectionBackground: token("--selection-background"),
      black: token("--border-strong"),
      red: token("--error"),
      green: token("--success"),
      yellow: token("--warning"),
      blue: token("--accent"),
      magenta: token("--flow-entity"),
      cyan: token("--flow-dependency"),
      white: token("--foreground"),
      brightBlack: token("--muted-foreground"),
      brightRed: token("--error"),
      brightGreen: token("--success"),
      brightYellow: token("--warning"),
      brightBlue: token("--accent"),
      brightMagenta: token("--flow-entity"),
      brightCyan: token("--flow-dependency"),
      brightWhite: token("--foreground"),
    };
  }

  function write(line: string): void {
    term?.write(`${line}\r\n`);
  }

  function render(next: string[]): void {
    if (term === undefined) return;
    const previous = rendered;
    if (next.length === 0) {
      if (previous.length > 0) term.clear();
      rendered = [];
      return;
    }

    let shared = 0;
    while (shared < previous.length && shared < next.length && previous[shared] === next[shared]) {
      shared += 1;
    }

    if (shared === previous.length && shared === next.length) return;

    if (shared === next.length) {
      term.reset();
      next.forEach(write);
    } else if (shared === previous.length) {
      next.slice(shared).forEach(write);
    } else if (shared === previous.length - 1) {
      term.write("\x1b[1A\x1b[2K\r");
      next.slice(shared).forEach(write);
    } else {
      term.reset();
      next.forEach(write);
    }

    rendered = [...next];
    if (stick) term.scrollToBottom();
  }

  onMount(() => {
    term = new Terminal({
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      fontSize: 12,
      lineHeight: 1.25,
      fontFamily: MONO_FONT,
      scrollback: 5000,
      screenReaderMode: true,
      theme: palette(),
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    term.onScroll(() => {
      const buffer = term?.buffer.active;
      if (buffer === undefined) return;
      stick = buffer.viewportY >= buffer.baseY;
    });

    window.__devboardTerminals ??= new Map();
    window.__devboardTerminals.set(testid, {
      getBuffer: () => {
        const active = term?.buffer.active;
        if (active === undefined) return "";
        const rows: string[] = [];
        for (let index = 0; index < active.length; index += 1) {
          rows.push(active.getLine(index)?.translateToString(true) ?? "");
        }
        return rows.join("\n").trimEnd();
      },
    });

    const observer = new ResizeObserver(() => {
      fit?.fit();
    });
    observer.observe(host);

    const themeObserver = new MutationObserver(() => {
      if (term !== undefined) term.options.theme = palette();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    render(lines);

    return () => {
      observer.disconnect();
      themeObserver.disconnect();
      window.__devboardTerminals?.delete(testid);
      term?.dispose();
      term = undefined;
    };
  });

  $effect(() => {
    render(lines);
  });

  $effect(() => {
    void layout.theme;
    if (term !== undefined) term.options.theme = palette();
  });
</script>

<div
  class={`terminal-host ${className}`}
  data-testid={testid}
  data-terminal
  role="log"
  aria-label={label}
  bind:this={host}
></div>

<style>
  .terminal-host {
    background: var(--background);
    border: 1px solid var(--border);
    border-radius: 4px;
    height: 100%;
    min-height: 120px;
    overflow: hidden;
    padding: 4px;
    width: 100%;
  }

  .terminal-host :global(.xterm) {
    height: 100%;
  }
</style>
