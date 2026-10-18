/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Folder of the engine files relative to the page, for example `engine/<hash>/`. */
  readonly VITE_ENGINE_BASE?: string;
}
