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
    const read = (name: string, fallback: string): string => {
      const value = styles.getPropertyValue(name).trim();
      return value.length > 0 ? value : fallback;
    };
    const light = document.documentElement.dataset.theme === "light";
    return {
      background: light ? "#ffffff" : "#0d1117",
      foreground: light ? "#1f2328" : "#e6edf3",
      cursor: light ? "#0969da" : "#58a6ff",
      selectionBackground: light ? "#b6d7ff" : "#264f78",
      black: light ? "#24292f" : "#484f58",
      red: light ? "#cf222e" : "#ff7b72",
      green: light ? "#116329" : "#3fb950",
      yellow: light ? "#7d4e00" : "#d29922",
      blue: light ? "#0550ae" : "#58a6ff",
      magenta: light ? "#8250df" : "#bc8cff",
      cyan: light ? "#1b7c83" : "#39c5cf",
      white: light ? "#6e7781" : "#b1bac4",
      brightBlack: light ? "#57606a" : "#6e7681",
      brightRed: read("--error", light ? "#a40e26" : "#ff7b72"),
      brightGreen: read("--success", light ? "#1a7f37" : "#3fb950"),
      brightYellow: light ? "#9a6700" : "#e3b341",
      brightBlue: read("--accent", light ? "#0969da" : "#58a6ff"),
      brightMagenta: light ? "#6639ba" : "#d2a8ff",
      brightCyan: light ? "#3192aa" : "#76e3ea",
      brightWhite: light ? "#1f2328" : "#f0f6fc",
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
