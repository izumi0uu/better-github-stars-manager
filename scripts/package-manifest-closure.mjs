import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const WORKER_BYTE_CEILING = 740_206;
export const RELEASE_WORKER_BASELINE = Object.freeze({
  relativePath: 'assets/index.ts-CkQeZGmv.js',
  bytes: WORKER_BYTE_CEILING,
  sha256: '9752d7463acee5886173e823f981c94c73bd0f2ac61e23724e3b79462636595e',
});

const SHA256 = /^[0-9a-f]{64}$/u;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const WINDOWS_DRIVE = /^[A-Za-z]:/u;
const STATIC_SIDE_EFFECT_IMPORT = /^\uFEFF?\s*import\s+(['"])(\.\.?\/[A-Za-z0-9._/-]+\.js)\1\s*;?\s*$/u;
const PATH_CONTROL = /[\u0000-\u001f\u007f]/u;
const ENCODED_PATH_ALIAS = /%/u;

export class PackageClosureError extends Error {
  constructor(code, label = 'package') {
    super(`${code}: ${label}`);
    this.name = 'PackageClosureError';
    this.code = code;
    this.label = label;
  }
}

export function parseChromeExtensionVersion(value, label = 'extension version') {
  if (typeof value !== 'string' || value.length > 23) throw new PackageClosureError('extension_version_invalid', label);
  const components = value.split('.');
  if (components.length < 1 || components.length > 4) {
    throw new PackageClosureError('extension_version_invalid', label);
  }
  const parsed = components.map((component) => {
    if (!/^(?:0|[1-9]\d*)$/u.test(component)) {
      throw new PackageClosureError('extension_version_invalid', label);
    }
    const number = Number(component);
    if (!Number.isSafeInteger(number) || number > 65_535) {
      throw new PackageClosureError('extension_version_invalid', label);
    }
    return number;
  });
  if (parsed.every((component) => component === 0)) {
    throw new PackageClosureError('extension_version_invalid', label);
  }
  return Object.freeze(parsed);
}

export function compareChromeExtensionVersions(left, right) {
  const leftParts = parseChromeExtensionVersion(left, 'left extension version');
  const rightParts = parseChromeExtensionVersion(right, 'right extension version');
  for (let index = 0; index < 4; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

export function normalizePackageRelativePath(value, label = 'package path') {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value) > 512
    || PATH_CONTROL.test(value)
    || value.includes('\\')
    || value.startsWith('/')
    || WINDOWS_DRIVE.test(value)
    || URL_SCHEME.test(value)
    || value.includes('?')
    || value.includes('#')
    || ENCODED_PATH_ALIAS.test(value)
  ) throw new PackageClosureError('package_path_invalid', label);

  const segments = value.split('/');
  if (
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    || path.posix.normalize(value) !== value
  ) throw new PackageClosureError('package_path_invalid', label);
  return value;
}

export function resolvePackagePath(root, value, label = 'package path') {
  const relativePath = normalizePackageRelativePath(value, label);
  const requestedRoot = path.resolve(root);
  const rootStats = lstatPackagePath(requestedRoot, 'package_root_missing', label);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new PackageClosureError('package_root_invalid', label);
  }
  const canonicalRoot = realpathPackagePath(requestedRoot, 'package_root_invalid', label);
  const canonicalRootStats = lstatPackagePath(canonicalRoot, 'package_root_invalid', label);
  if (!sameFileIdentity(rootStats, canonicalRootStats)) {
    throw new PackageClosureError('package_root_changed', label);
  }

  let current = canonicalRoot;
  const traversed = [];
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment);
    const stats = lstatPackagePath(current, 'package_file_missing', label);
    if (stats.isSymbolicLink()) throw new PackageClosureError('package_symlink_rejected', label);
    traversed.push(Object.freeze({ absolutePath: current, stats }));
  }
  const finalStats = traversed.at(-1).stats;
  if (!finalStats.isFile()) throw new PackageClosureError('package_file_not_regular', label);
  const canonical = realpathPackagePath(current, 'package_file_missing', label);
  if (!isInside(canonicalRoot, canonical) || canonical !== current) {
    throw new PackageClosureError('package_path_escaped', label);
  }
  for (const entry of traversed) {
    const currentStats = lstatPackagePath(entry.absolutePath, 'package_file_missing', label);
    if (currentStats.isSymbolicLink()) throw new PackageClosureError('package_symlink_rejected', label);
    if (!sameFileIdentity(entry.stats, currentStats)) {
      throw new PackageClosureError('package_path_changed', label);
    }
  }
  const finalRootStats = lstatPackagePath(requestedRoot, 'package_root_missing', label);
  if (!sameFileIdentity(rootStats, finalRootStats)
    || realpathPackagePath(requestedRoot, 'package_root_invalid', label) !== canonicalRoot) {
    throw new PackageClosureError('package_root_changed', label);
  }
  return canonical;
}

export function parseMv3WorkerLoader({ manifest, loaderText }) {
  const backgroundLoader = resolveMv3BackgroundLoader(manifest);
  const { loaderRelativePath } = backgroundLoader;
  if (typeof loaderText !== 'string') {
    throw new PackageClosureError('worker_loader_invalid', loaderRelativePath);
  }
  const match = STATIC_SIDE_EFFECT_IMPORT.exec(loaderText);
  if (!match) throw new PackageClosureError('worker_loader_import_invalid', loaderRelativePath);
  const importPath = match[2];
  if (!importPath.startsWith('./')) {
    throw new PackageClosureError('worker_loader_import_external', loaderRelativePath);
  }
  const importSegments = importPath.slice(2).split('/');
  if (importSegments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new PackageClosureError('worker_loader_import_escaped', loaderRelativePath);
  }
  let workerRelativePath;
  try {
    workerRelativePath = normalizeJavaScriptPath(
      path.posix.join(path.posix.dirname(loaderRelativePath), importPath),
      'background worker import',
    );
  } catch {
    throw new PackageClosureError('worker_loader_import_escaped', loaderRelativePath);
  }
  if (workerRelativePath === loaderRelativePath) {
    throw new PackageClosureError('worker_loader_import_self', loaderRelativePath);
  }
  return Object.freeze({ loaderRelativePath, workerRelativePath });
}

export function collectManifestResourceReferences(manifest) {
  if (!isPlainObject(manifest)) throw new PackageClosureError('manifest_invalid');
  const references = new Map();
  const add = (candidate, referrer) => {
    const relativePath = normalizePackageRelativePath(candidate, referrer);
    if (containsWildcard(relativePath)) {
      throw new PackageClosureError('manifest_resource_wildcard', referrer);
    }
    const referrers = references.get(relativePath) ?? [];
    if (!referrers.includes(referrer)) referrers.push(referrer);
    references.set(relativePath, referrers);
  };
  addIconSet(manifest.icons, 'icons', add);
  if (isPlainObject(manifest.action)) {
    addIconSet(manifest.action.default_icon, 'action.default_icon', add);
    addOptionalString(manifest.action.default_popup, 'action.default_popup', add);
  }
  addOptionalString(manifest.options_page, 'options_page', add);
  if (isPlainObject(manifest.options_ui)) addOptionalString(manifest.options_ui.page, 'options_ui.page', add);
  addOptionalString(manifest.devtools_page, 'devtools_page', add);
  if (isPlainObject(manifest.side_panel)) addOptionalString(manifest.side_panel.default_path, 'side_panel.default_path', add);
  if (isPlainObject(manifest.chrome_url_overrides)) {
    for (const [name, candidate] of Object.entries(manifest.chrome_url_overrides)) {
      addOptionalString(candidate, `chrome_url_overrides.${name}`, add);
    }
  }
  if (isPlainObject(manifest.background)) {
    const backgroundLoader = resolveMv3BackgroundLoader(manifest);
    add(backgroundLoader.loaderRelativePath, backgroundLoader.manifestReferrer);
  }
  if (isPlainObject(manifest.storage)) {
    addOptionalString(manifest.storage.managed_schema, 'storage.managed_schema', add);
  }
  collectArrayResources(manifest.declarative_net_request?.rule_resources, 'declarative_net_request.rule_resources', (resource, referrer) => {
    if (!isPlainObject(resource)) throw new PackageClosureError('manifest_invalid', referrer);
    addOptionalString(resource.path, `${referrer}.path`, add);
  });
  collectArrayResources(manifest.sandbox?.pages, 'sandbox.pages', add);
  collectArrayResources(manifest.content_scripts, 'content_scripts', (script, scriptReferrer) => {
    if (!isPlainObject(script)) throw new PackageClosureError('manifest_invalid', scriptReferrer);
    collectArrayResources(script.js, `${scriptReferrer}.js`, add);
    collectArrayResources(script.css, `${scriptReferrer}.css`, add);
  });
  collectArrayResources(manifest.web_accessible_resources, 'web_accessible_resources', (resourceSet, setReferrer) => {
    if (!isPlainObject(resourceSet)) throw new PackageClosureError('manifest_invalid', setReferrer);
    collectArrayResources(resourceSet.resources, `${setReferrer}.resources`, add);
  });
  return Object.freeze(
    [...references]
      .sort(([left], [right]) => bytewiseCompare(left, right))
      .map(([relativePath, referencedBy]) => Object.freeze({
        relativePath,
        referencedBy: Object.freeze([...referencedBy].sort(bytewiseCompare)),
      })),
  );
}

export function validateManifestResourceClosure({ manifest, packageEntries }) {
  const entries = indexPackageEntries(packageEntries);
  const manifestEntry = entries.get('manifest.json');
  if (!manifestEntry) throw new PackageClosureError('root_manifest_missing');
  let packagedManifest;
  try {
    packagedManifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestEntry.bytes));
  } catch {
    throw new PackageClosureError('packaged_manifest_invalid', 'manifest.json');
  }
  if (!sameJsonValue(packagedManifest, manifest)) {
    throw new PackageClosureError('packaged_manifest_mismatch', 'manifest.json');
  }
  parseChromeExtensionVersion(packagedManifest.version, 'manifest.version');
  const references = collectManifestResourceReferences(packagedManifest).map((entry) => ({
    relativePath: entry.relativePath,
    referencedBy: [...entry.referencedBy],
  }));
  const backgroundLoader = resolveMv3BackgroundLoader(packagedManifest);
  const loaderRelativePath = backgroundLoader.loaderRelativePath;
  const loader = entries.get(loaderRelativePath);
  if (!loader) throw new PackageClosureError('manifest_resource_missing', loaderRelativePath);
  const { workerRelativePath } = parseMv3WorkerLoader({
    manifest: packagedManifest,
    loaderText: decodeUtf8(loader.bytes, loaderRelativePath),
  });
  const workerImportReferrer = `${backgroundLoader.manifestReferrer}.import`;
  const workerRef = references.find((entry) => entry.relativePath === workerRelativePath);
  if (workerRef) workerRef.referencedBy.push(workerImportReferrer);
  else references.push({
    relativePath: workerRelativePath,
    referencedBy: [workerImportReferrer],
  });
  references.sort((left, right) => bytewiseCompare(left.relativePath, right.relativePath));

  const resources = references.map(({ relativePath, referencedBy }) => {
    const entry = entries.get(relativePath);
    if (!entry) throw new PackageClosureError('manifest_resource_missing', relativePath);
    return Object.freeze({
      ...measureFileArtifact({ relativePath, bytes: entry.bytes }),
      referencedBy: Object.freeze([...new Set(referencedBy)].sort(bytewiseCompare)),
    });
  });
  return Object.freeze({
    manifestResourcesClosed: true,
    workerRelativePath,
    resources: Object.freeze(resources),
  });
}

export function measureBundleArtifact({ relativePath, bytes }) {
  const safePath = normalizePackageRelativePath(relativePath, 'bundle artifact');
  const buffer = toBuffer(bytes, safePath);
  if (!safePath.endsWith('.js')) throw new PackageClosureError('javascript_artifact_required', safePath);
  return Object.freeze({
    relativePath: safePath,
    bytes: buffer.byteLength,
    kib: buffer.byteLength / 1024,
    sha256: hash(buffer),
  });
}

function measureFileArtifact({ relativePath, bytes }) {
  const safePath = normalizePackageRelativePath(relativePath, 'package artifact');
  const buffer = toBuffer(bytes, safePath);
  return Object.freeze({
    relativePath: safePath,
    bytes: buffer.byteLength,
    sha256: hash(buffer),
  });
}

export function enforceWorkerByteCeiling(worker, ceilingBytes = WORKER_BYTE_CEILING, expectedIdentity) {
  assertWorkerIdentity(worker, 'worker_measurement_invalid', true);
  if (!Number.isSafeInteger(ceilingBytes) || ceilingBytes <= 0) {
    throw new PackageClosureError('worker_ceiling_invalid');
  }
  if (worker.bytes > ceilingBytes) {
    throw new PackageClosureError('worker_byte_ceiling_exceeded', worker.relativePath);
  }
  if (expectedIdentity !== undefined) enforceWorkerIdentity(worker, expectedIdentity);
  return Object.freeze({ ...worker, ceilingBytes, withinCeiling: true });
}

export function enforceWorkerReleaseBaseline(worker, baseline = RELEASE_WORKER_BASELINE) {
  enforceWorkerByteCeiling(worker, baseline?.bytes);
  return enforceWorkerIdentity(worker, baseline);
}

export function enforceWorkerIdentity(worker, expectedIdentity) {
  assertWorkerIdentity(worker, 'worker_measurement_invalid', true);
  assertWorkerIdentity(expectedIdentity, 'worker_identity_invalid', false);
  if (
    worker.relativePath !== expectedIdentity.relativePath
    || worker.bytes !== expectedIdentity.bytes
    || worker.sha256 !== expectedIdentity.sha256
  ) throw new PackageClosureError('worker_identity_mismatch', worker.relativePath);
  return Object.freeze({ ...worker });
}

export function discoverMermaidArtifacts(packageEntries) {
  const entries = indexPackageEntries(packageEntries);
  return Object.freeze(
    [...entries.values()]
      .filter(({ relativePath }) => /^mermaid-[A-Za-z0-9._-]+\.js$/u.test(path.posix.basename(relativePath)))
      .sort((left, right) => bytewiseCompare(left.relativePath, right.relativePath))
      .map((entry) => measureBundleArtifact(entry)),
  );
}

export function classifyForbiddenPackageEntry(relativePath) {
  const safePath = normalizePackageRelativePath(relativePath, 'package entry');
  const segments = safePath.toLowerCase().split('/');
  const basename = segments.at(-1);
  if (basename === '.ds_store') return 'source_or_local_state';
  if (basename === '.env' || basename.startsWith('.env.') || basename.endsWith('.env')) {
    return 'private_or_development_artifact';
  }
  if (/\.(?:pem|key|cert|crt|cer|p12|pfx)$/u.test(basename)) {
    return 'private_or_development_artifact';
  }
  if (/^(?:credentials?|secrets?)(?:\.[a-z0-9_-]+)+$/u.test(basename)) {
    return 'private_or_development_artifact';
  }
  if (segments.some((segment) => /^(?:credentials?|secrets?|keys?|certs?|certificates?)$/u.test(segment))) {
    return 'private_or_development_artifact';
  }
  const artifactStem = basename.replace(/\.(?:json|txt|log)$/u, '');
  if (segments.some((segment) => segment.startsWith('.'))) {
    return 'source_or_local_state';
  }
  if (segments.some((segment) => ['docs', 'poster', 'store', 'store-assets'].includes(segment))) {
    return 'source_or_local_state';
  }
  if (segments.some((segment) => ['.local-state', 'local-state', 'local_state'].includes(segment))) {
    return 'source_or_local_state';
  }
  if (segments[0] === 'src' && segments[1] === 'dev-agent') return 'private_or_development_artifact';
  if (basename.endsWith('.map')) return 'source_map';
  if (segments.some((segment) => ['raw-capture', 'raw-captures', 'provider-capture', 'provider-captures'].includes(segment))) {
    return 'private_or_development_artifact';
  }
  if (segments.some((segment) => ['diagnostic', 'diagnostics', 'agent-diagnostic', 'agent-diagnostics', 'dev-diagnostic', 'dev-diagnostics'].includes(segment))) {
    return 'private_or_development_artifact';
  }
  if (/(?:^|[-_])(?:raw|provider)[-_]captures?$/u.test(artifactStem)) {
    return 'private_or_development_artifact';
  }
  if (/^(?:diagnostic|diagnostics|agent[-_]diagnostic|agent[-_]diagnostics|dev[-_]diagnostic|dev[-_]diagnostics)$/u.test(artifactStem)) {
    return 'private_or_development_artifact';
  }
  if (/^(?:credentials?|secrets?)$/u.test(artifactStem) || /^(?:dev|development)[-_]build[-_]hash$/u.test(artifactStem)) {
    return 'private_or_development_artifact';
  }
  const timestamp = '(?:\\d{10,17}|\\d{8}t\\d{6}(?:\\.\\d+)?z?|\\d{4}-\\d{2}-\\d{2}t\\d{2}(?:[-:]?\\d{2}){2}(?:\\.\\d+)?z?)';
  if (new RegExp(`^(?:(?:provider[-_])?(?:raw[-_])?captures?|credentials?|diagnostics?)[-_.]${timestamp}$`, 'u').test(artifactStem)) {
    return 'private_or_development_artifact';
  }
  return null;
}

function indexPackageEntries(packageEntries) {
  if (!Array.isArray(packageEntries)) throw new PackageClosureError('package_entries_invalid');
  const entries = new Map();
  for (let index = 0; index < packageEntries.length; index += 1) {
    const entry = packageEntries[index];
    if (!isPlainObject(entry)) throw new PackageClosureError('package_entry_invalid', `packageEntries[${index}]`);
    const relativePath = normalizePackageRelativePath(entry.relativePath, `packageEntries[${index}]`);
    if (entries.has(relativePath)) throw new PackageClosureError('package_entry_duplicate', relativePath);
    if (entry.symlink === true || (entry.type !== undefined && entry.type !== 'file')) {
      throw new PackageClosureError('package_entry_not_regular', relativePath);
    }
    if (classifyForbiddenPackageEntry(relativePath) !== null) {
      throw new PackageClosureError('package_entry_forbidden', relativePath);
    }
    const bytes = toBuffer(entry.bytes, relativePath);
    if (entry.sha256 !== undefined && (!SHA256.test(entry.sha256) || entry.sha256 !== hash(bytes))) {
      throw new PackageClosureError('package_entry_hash_mismatch', relativePath);
    }
    entries.set(relativePath, Object.freeze({ relativePath, bytes }));
  }
  return entries;
}

function resolveMv3BackgroundLoader(manifest) {
  if (
    !isPlainObject(manifest)
    || manifest.manifest_version !== 3
    || !isPlainObject(manifest.background)
    || manifest.background.type !== 'module'
  ) throw new PackageClosureError('mv3_module_worker_required', 'background');

  const background = manifest.background;
  const hasServiceWorker = Object.hasOwn(background, 'service_worker');
  const hasScripts = Object.hasOwn(background, 'scripts');
  if (hasServiceWorker === hasScripts) {
    throw new PackageClosureError(
      hasServiceWorker ? 'mv3_background_ambiguous' : 'mv3_module_worker_required',
      'background',
    );
  }

  if (hasServiceWorker) {
    return Object.freeze({
      loaderRelativePath: normalizeJavaScriptPath(background.service_worker, 'background.service_worker'),
      manifestReferrer: 'background.service_worker',
    });
  }
  if (!Array.isArray(background.scripts) || background.scripts.length !== 1) {
    throw new PackageClosureError('mv3_background_scripts_invalid', 'background.scripts');
  }
  return Object.freeze({
    loaderRelativePath: normalizeJavaScriptPath(background.scripts[0], 'background.scripts[0]'),
    manifestReferrer: 'background.scripts[0]',
  });
}
function normalizeJavaScriptPath(value, label) {
  const relativePath = normalizePackageRelativePath(value, label);
  if (containsWildcard(relativePath)) throw new PackageClosureError('package_path_invalid', label);
  if (!relativePath.endsWith('.js')) throw new PackageClosureError('javascript_path_required', label);
  return relativePath;
}

function addIconSet(value, referrer, add) {
  if (typeof value === 'string') {
    add(value, referrer);
    return;
  }
  if (value === undefined) return;
  if (!isPlainObject(value)) throw new PackageClosureError('manifest_invalid', referrer);
  for (const [size, candidate] of Object.entries(value)) add(candidate, `${referrer}.${size}`);
}

function addOptionalString(value, referrer, add) {
  if (value === undefined) return;
  if (typeof value !== 'string') throw new PackageClosureError('manifest_invalid', referrer);
  add(value, referrer);
}

function collectArrayResources(value, referrer, collect) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new PackageClosureError('manifest_invalid', referrer);
  value.forEach((entry, index) => collect(entry, `${referrer}[${index}]`));
}

function containsWildcard(value) {
  return /[*?\[\]{}]/u.test(value);
}

function toBuffer(value, label) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return Buffer.from(value);
  throw new PackageClosureError('package_entry_bytes_invalid', label);
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new PackageClosureError('package_entry_bytes_invalid', label);
  }
}

function assertWorkerIdentity(value, code, requireKib) {
  if (!isPlainObject(value)) throw new PackageClosureError(code);
  const expectedKeys = requireKib
    ? ['bytes', 'kib', 'relativePath', 'sha256']
    : ['bytes', 'relativePath', 'sha256'];
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.some((key) => typeof key !== 'string')
    || actualKeys.length !== expectedKeys.length
    || !actualKeys.every((key) => expectedKeys.includes(key))
  ) throw new PackageClosureError(code);
  let relativePath;
  try {
    relativePath = normalizeJavaScriptPath(value.relativePath, 'worker identity');
  } catch {
    throw new PackageClosureError(code);
  }
  if (
    !Number.isSafeInteger(value.bytes)
    || value.bytes < 0
    || !SHA256.test(value.sha256)
    || (requireKib && value.kib !== value.bytes / 1024)
  ) throw new PackageClosureError(code, relativePath);
}

function lstatPackagePath(absolutePath, missingCode, label) {
  try {
    return lstatSync(absolutePath, { bigint: true });
  } catch {
    throw new PackageClosureError(missingCode, label);
  }
}

function realpathPackagePath(absolutePath, invalidCode, label) {
  try {
    return realpathSync(absolutePath);
  } catch {
    throw new PackageClosureError(invalidCode, label);
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}


function sameJsonValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => sameJsonValue(entry, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left).sort(bytewiseCompare);
    const rightKeys = Object.keys(right).sort(bytewiseCompare);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && sameJsonValue(left[key], right[key]));
  }
  return false;
}
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
