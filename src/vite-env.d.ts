/// <reference types="vite/client" />

declare module '*.css?inline' {
  const css: string;
  export default css;
}

declare module '*.css';

declare const __GSM_DEV__: boolean;
declare const __GSM_DEV_UI_VISIBLE__: boolean;
declare const __GSM_VERSION_HASH__: string;
declare const __GSM_STORE_TARGET__: string;
