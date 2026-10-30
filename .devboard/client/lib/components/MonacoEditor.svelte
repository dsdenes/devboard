<script lang="ts">
  import { onMount } from "svelte";
  import * as monaco from "monaco-editor/editor/editor.api";
  import "monaco-editor/languages/definitions/markdown/register";
  import EditorWorker from "monaco-editor/editor/editor.worker?worker";
  import { layout } from "../layout.svelte";

  interface Props {
    value: string;
    label: string;
    "data-testid": string;
    language?: string;
    readOnly?: boolean;
    dirty?: boolean;
    minHeight?: number;
    onchange?: (value: string) => void;
    onsave?: () => void;
  }

  let {
    value,
    label,
    "data-testid": testid,
    language = "markdown",
    readOnly = false,
    dirty = false,
    minHeight = 0,
    onchange,
    onsave,
  }: Props = $props();

  let host: HTMLDivElement;
  let editor: monaco.editor.IStandaloneCodeEditor | undefined;
  let applyingExternal = false;

  const environment = self as unknown as { MonacoEnvironment: unknown };
  environment.MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };

  const THEME = "devboard";

  const COLOR_TOKENS: Record<string, string> = {
    "editor.background": "--background",
    "editor.foreground": "--foreground",
    "editorLineNumber.foreground": "--muted-foreground",
    "editorLineNumber.activeForeground": "--foreground",
    "editor.selectionBackground": "--selection-background",
    "editor.lineHighlightBackground": "--surface",
    "editorCursor.foreground": "--accent",
    "editorWidget.background": "--surface",
    "editorWidget.border": "--border-strong",
    "scrollbarSlider.background": "--border",
    "scrollbarSlider.hoverBackground": "--border-strong",
  };

  const RULE_TOKENS: { token: string; color: string; fontStyle?: string }[] = [
    { token: "keyword", color: "--error" },
    { token: "string", color: "--accent" },
    { token: "comment", color: "--muted-foreground", fontStyle: "italic" },
    { token: "heading", color: "--accent", fontStyle: "bold" },
    { token: "strong", color: "--foreground", fontStyle: "bold" },
    { token: "emphasis", color: "--foreground", fontStyle: "italic" },
  ];

  function applyTheme(): void {
    const styles = getComputedStyle(document.documentElement);
    const token = (name: string): string => {
      const value = styles.getPropertyValue(name).trim();
      // The build minifies opaque colors to shorthand hex; Monaco's color
      // parsers only accept the six- and eight-digit forms.
      const shorthand = /^#([0-9a-f]{3,4})$/i.exec(value);
      if (shorthand === null) return value;
      const digits = shorthand[1] ?? "";
      return `#${[...digits].map((digit) => digit + digit).join("")}`;
    };

    const colors: Record<string, string> = {};
    for (const [id, name] of Object.entries(COLOR_TOKENS)) {
      const value = token(name);
      if (value.length > 0) colors[id] = value;
    }

    const rules: monaco.editor.ITokenThemeRule[] = [];
    for (const rule of RULE_TOKENS) {
      const foreground = token(rule.color);
      if (foreground.length === 0) continue;
      rules.push(
        rule.fontStyle === undefined
          ? { token: rule.token, foreground }
          : { token: rule.token, foreground, fontStyle: rule.fontStyle },
      );
    }

    monaco.editor.defineTheme(THEME, {
      base: document.documentElement.dataset.theme === "light" ? "vs" : "vs-dark",
      inherit: true,
      rules,
      colors,
    });
    monaco.editor.setTheme(THEME);
  }

  onMount(() => {
    if (host === undefined) return;
    applyTheme();
    editor = monaco.editor.create(host, {
      value,
      language,
      theme: THEME,
      ariaLabel: label,
      readOnly,
      domReadOnly: readOnly,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: "on",
      fontSize: 12,
      lineHeight: 17.4,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      padding: { top: 8, bottom: 8 },
      renderLineHighlight: "line",
      lineNumbersMinChars: 3,
      folding: false,
      glyphMargin: false,
      overviewRulerBorder: false,
      overviewRulerLanes: 0,
      scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9 },
      contextmenu: true,
      stickyScroll: { enabled: false },
    });

    for (const area of host.querySelectorAll("textarea")) {
      area.setAttribute("aria-label", label);
    }

    editor.onDidChangeModelContent(() => {
      if (applyingExternal) return;
      onchange?.(editor?.getValue() ?? "");
    });

    window.__devboardEditors ??= new Map();
    window.__devboardEditors.set(testid, {
      getValue: () => editor?.getValue() ?? "",
      setValue: (text: string) => editor?.setValue(text),
      isDirty: () => dirty,
      save: () => onsave?.(),
      focus: () => editor?.focus(),
    });

    return () => {
      window.__devboardEditors?.delete(testid);
      editor?.dispose();
      editor = undefined;
    };
  });

  $effect(() => {
    const next = value;
    if (editor === undefined) return;
    if (editor.getValue() === next) return;
    applyingExternal = true;
    editor.setValue(next);
    applyingExternal = false;
  });

  $effect(() => {
    editor?.updateOptions({ readOnly, domReadOnly: readOnly });
  });

  $effect(() => {
    void layout.theme;
    applyTheme();
  });
</script>

<div
  class="monaco-host"
  class:is-dirty={dirty}
  style:min-height={minHeight > 0 ? `${minHeight}px` : undefined}
  data-testid={testid}
  data-monaco-editor={testid}
  data-dirty={dirty ? "true" : "false"}
  aria-label={label}
  role="group"
  bind:this={host}
></div>

<style>
  .monaco-host {
    border: 1px solid var(--border);
    border-radius: 4px;
    height: 100%;
    min-height: 120px;
    overflow: hidden;
    width: 100%;
  }

  .monaco-host.is-dirty {
    border-color: var(--warning);
  }
</style>
