/// <reference types="vite/client" />

declare module '*.css?inline' {
  const css: string;
  export default css;
}

declare module '*.css';

declare const __GSM_DEV__: boolean;
declare const __GSM_VERSION_HASH__: string;
