export const PRODUCT_STORE_TARGETS = [
  'chrome',
  'firefox',
  'edge',
  'opera',
  'none',
] as const;

export type ProductStoreTarget = typeof PRODUCT_STORE_TARGETS[number];

export function isProductStoreTarget(value: unknown): value is ProductStoreTarget {
  return typeof value === 'string'
    && (PRODUCT_STORE_TARGETS as readonly string[]).includes(value);
}

export function normalizeProductStoreTarget(value: unknown): ProductStoreTarget {
  return isProductStoreTarget(value) ? value : 'none';
}

export function parseProductStoreTarget(value: unknown): ProductStoreTarget {
  if (!isProductStoreTarget(value)) {
    throw new TypeError(`Unsupported product store target: ${String(value)}.`);
  }
  return value;
}
