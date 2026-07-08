type RuntimeLastError = { message?: string } | undefined;
type MaybePromise<T> = T | Promise<T>;
type StorageGetKeys = string | string[] | Record<string, unknown> | null | undefined;
type StorageItems = Record<string, unknown>;
export type BrowserRuntimeMessageSender = Record<string, unknown>;
export type BrowserRuntimeInstalledDetails = Record<string, unknown>;
export type BrowserStorageChange = { oldValue?: unknown; newValue?: unknown };
export type BrowserStorageAreaName = string;
export type BrowserTabCreateProperties = { url?: string; [key: string]: unknown };
export type BrowserTab = { id?: number; url?: string; [key: string]: unknown };

type RuntimeMessageListener = (
  message: unknown,
  sender: BrowserRuntimeMessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | void | Promise<unknown>;
type RuntimeInstalledListener = (details: BrowserRuntimeInstalledDetails) => void;
type StorageChangedListener = (
  changes: Record<string, BrowserStorageChange>,
  areaName: BrowserStorageAreaName,
) => void;

interface RuntimeEvent<TListener extends (...args: never[]) => unknown> {
  addListener(listener: TListener): void;
  removeListener(listener: TListener): void;
}

interface RuntimeApi {
  lastError?: RuntimeLastError;
  sendMessage(message: unknown): MaybePromise<unknown>;
  sendMessage(message: unknown, callback: (response: unknown) => void): void;
  onMessage: RuntimeEvent<RuntimeMessageListener>;
  onInstalled: RuntimeEvent<RuntimeInstalledListener>;
  openOptionsPage(): MaybePromise<void>;
  openOptionsPage(callback: () => void): void;
}

interface StorageLocalApi {
  get(keys?: StorageGetKeys): MaybePromise<Record<string, unknown>>;
  get(keys: StorageGetKeys, callback: (items: Record<string, unknown>) => void): void;
  set(items: StorageItems): MaybePromise<void>;
  set(items: StorageItems, callback: () => void): void;
  clear(): MaybePromise<void>;
  clear(callback: () => void): void;
}

interface StorageApi {
  local: StorageLocalApi;
  onChanged: RuntimeEvent<StorageChangedListener>;
}

interface TabsApi {
  create(createProperties: BrowserTabCreateProperties): MaybePromise<BrowserTab | undefined>;
  create(
    createProperties: BrowserTabCreateProperties,
    callback: (tab: BrowserTab | undefined) => void,
  ): void;
}

interface BrowserExtensionApi {
  runtime: RuntimeApi;
  storage: StorageApi;
  tabs: TabsApi;
}

type RuntimeGlobal = 'browser' | 'chrome';

function getExtensionApi(): { api: BrowserExtensionApi; globalName: RuntimeGlobal } {
  const globals = globalThis as typeof globalThis & {
    browser?: BrowserExtensionApi;
    chrome?: BrowserExtensionApi;
  };
  if (globals.browser) return { api: globals.browser, globalName: 'browser' };
  if (globals.chrome) return { api: globals.chrome, globalName: 'chrome' };
  throw new Error('Browser extension runtime API is unavailable');
}

export function isBrowserStorageAvailable(): boolean {
  const globals = globalThis as typeof globalThis & {
    browser?: Partial<BrowserExtensionApi>;
    chrome?: Partial<BrowserExtensionApi>;
  };
  const api = globals.browser ?? globals.chrome;
  return Boolean(api?.storage?.onChanged);
}

function getLastError(runtime: RuntimeApi): Error | null {
  const lastError = runtime.lastError;
  if (!lastError) return null;
  return new Error(lastError.message || 'Browser runtime operation failed');
}

function isThenable<T>(value: MaybePromise<T> | void): value is Promise<T> {
  return Boolean(value && typeof (value as Promise<T>).then === 'function');
}

function invokeRuntime<T>(
  callPromiseApi: () => MaybePromise<T>,
  callCallbackApi: (callback: (value: T) => void) => MaybePromise<T> | void,
): Promise<T> {
  const { api, globalName } = getExtensionApi();
  if (globalName === 'browser') {
    return Promise.resolve(callPromiseApi());
  }

  return new Promise<T>((resolve, reject) => {
    const maybePromise = callCallbackApi((value) => {
      const lastError = getLastError(api.runtime);
      if (lastError) reject(lastError);
      else resolve(value);
    });
    if (isThenable(maybePromise)) {
      maybePromise.then(resolve, reject);
    }
  });
}

function assertPlainRuntimeValue(value: unknown, path: string, seen: WeakSet<object>): void {
  if (value === null) return;

  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'boolean') return;
  if (valueType === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must be a finite number for runtime messaging`);
    }
    return;
  }

  if (valueType !== 'object') {
    throw new TypeError(`${path} must be plain JSON-like data for runtime messaging`);
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) {
    throw new TypeError(`${path} contains a cycle and cannot be sent through runtime messaging`);
  }
  seen.add(objectValue);

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPlainRuntimeValue(item, `${path}[${index}]`, seen));
    return;
  }

  const prototype = Object.getPrototypeOf(objectValue);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object for runtime messaging`);
  }

  for (const [key, item] of Object.entries(objectValue)) {
    assertPlainRuntimeValue(item, `${path}.${key}`, seen);
  }
}

export function assertRuntimeMessagePayload(message: unknown): void {
  assertPlainRuntimeValue(message, 'message', new WeakSet<object>());
}

export const browserRuntime = {
  runtime: {
    sendMessage<T = unknown>(message: unknown): Promise<T> {
      assertRuntimeMessagePayload(message);
      return invokeRuntime<T>(
        () => getExtensionApi().api.runtime.sendMessage(message) as MaybePromise<T>,
        (callback) => getExtensionApi().api.runtime.sendMessage(message, callback as (response: unknown) => void),
      );
    },
    onMessage: {
      addListener(listener: RuntimeMessageListener): void {
        getExtensionApi().api.runtime.onMessage.addListener(listener);
      },
      removeListener(listener: RuntimeMessageListener): void {
        getExtensionApi().api.runtime.onMessage.removeListener(listener);
      },
    },
    onInstalled: {
      addListener(listener: RuntimeInstalledListener): void {
        getExtensionApi().api.runtime.onInstalled.addListener(listener);
      },
      removeListener(listener: RuntimeInstalledListener): void {
        getExtensionApi().api.runtime.onInstalled.removeListener(listener);
      },
    },
    openOptionsPage(): Promise<void> {
      return invokeRuntime<void>(
        () => getExtensionApi().api.runtime.openOptionsPage(),
        (callback) => getExtensionApi().api.runtime.openOptionsPage(callback),
      );
    },
  },
  storage: {
    local: {
      get(keys?: StorageGetKeys): Promise<Record<string, unknown>> {
        return invokeRuntime<Record<string, unknown>>(
          () => getExtensionApi().api.storage.local.get(keys),
          (callback) => getExtensionApi().api.storage.local.get(keys, callback),
        );
      },
      set(items: StorageItems): Promise<void> {
        return invokeRuntime<void>(
          () => getExtensionApi().api.storage.local.set(items),
          (callback) => getExtensionApi().api.storage.local.set(items, callback),
        );
      },
      clear(): Promise<void> {
        return invokeRuntime<void>(
          () => getExtensionApi().api.storage.local.clear(),
          (callback) => getExtensionApi().api.storage.local.clear(callback),
        );
      },
    },
    onChanged: {
      addListener(listener: StorageChangedListener): void {
        getExtensionApi().api.storage.onChanged.addListener(listener);
      },
      removeListener(listener: StorageChangedListener): void {
        getExtensionApi().api.storage.onChanged.removeListener(listener);
      },
    },
  },
  tabs: {
    create(createProperties: BrowserTabCreateProperties): Promise<BrowserTab | undefined> {
      return invokeRuntime<BrowserTab | undefined>(
        () => getExtensionApi().api.tabs.create(createProperties),
        (callback) => getExtensionApi().api.tabs.create(createProperties, callback),
      );
    },
  },
};
