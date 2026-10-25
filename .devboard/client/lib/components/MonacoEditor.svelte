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

  monaco.editor.defineTheme("devboard-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "ff7b72" },
      { token: "string", foreground: "a5d6ff" },
      { token: "comment", foreground: "8b949e", fontStyle: "italic" },
      { token: "heading", foreground: "79c0ff", fontStyle: "bold" },
      { token: "strong", foreground: "e6edf3", fontStyle: "bold" },
      { token: "emphasis", foreground: "e6edf3", fontStyle: "italic" },
    ],
    colors: {
      "editor.background": "#0d1117",
      "editor.foreground": "#e6edf3",
      "editorLineNumber.foreground": "#6e7681",
      "editorLineNumber.activeForeground": "#c9d1d9",
      "editor.selectionBackground": "#264f78",
      "editor.lineHighlightBackground": "#161b22",
      "editorCursor.foreground": "#58a6ff",
      "editorWidget.background": "#161b22",
      "editorWidget.border": "#6e7681",
      "scrollbarSlider.background": "#484f5866",
      "scrollbarSlider.hoverBackground": "#6e768199",
    },
  });

  monaco.editor.defineTheme("devboard-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "cf222e" },
      { token: "string", foreground: "0a3069" },
      { token: "comment", foreground: "57606a", fontStyle: "italic" },
      { token: "heading", foreground: "0550ae", fontStyle: "bold" },
    ],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#1f2328",
      "editorLineNumber.foreground": "#8c959f",
      "editorLineNumber.activeForeground": "#1f2328",
      "editor.selectionBackground": "#b6d7ff",
      "editor.lineHighlightBackground": "#f6f8fa",
      "editorCursor.foreground": "#0969da",
      "editorWidget.background": "#ffffff",
      "editorWidget.border": "#6e7781",
    },
  });

  function currentTheme(): string {
    return document.documentElement.dataset.theme === "light" ? "devboard-light" : "devboard-dark";
  }

  onMount(() => {
    if (host === undefined) return;
    editor = monaco.editor.create(host, {
      value,
      language,
      theme: currentTheme(),
      ariaLabel: label,
      readOnly,
      domReadOnly: readOnly,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: "on",
      fontSize: 13,
      lineHeight: 20,
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
    monaco.editor.setTheme(layout.theme === "light" ? "devboard-light" : "devboard-dark");
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
