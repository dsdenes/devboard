/// <reference types="vite/client" />

declare module "*?worker" {
  const workerConstructor: { new (): Worker };
  export default workerConstructor;
}

interface EditorHandle {
  getValue(): string;
  setValue(text: string): void;
  isDirty(): boolean;
  save(): void;
  focus(): void;
}

interface TerminalHandle {
  getBuffer(): string;
}

interface Window {
  __devboardEditors: Map<string, EditorHandle>;
  __devboardTerminals: Map<string, TerminalHandle>;
}
