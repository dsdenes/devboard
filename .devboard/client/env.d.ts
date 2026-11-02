/// <reference types="vite/client" />

interface TerminalHandle {
  getBuffer(): string;
}

interface Window {
  __devboardTerminals: Map<string, TerminalHandle>;
}
