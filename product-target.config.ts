export const PRODUCT_STORE_TARGETS = [
  'chrome',
  'firefox',
  'edge',
  'opera',
  'none',
] as const;

export type ProductStoreTarget = typeof PRODUCT_STORE_TARGETS[number];

export function normalizeProductStoreTarget(value: unknown): ProductStoreTarget {
  return typeof value === 'string'
    && (PRODUCT_STORE_TARGETS as readonly string[]).includes(value)
    ? value as ProductStoreTarget
    : 'none';
}
