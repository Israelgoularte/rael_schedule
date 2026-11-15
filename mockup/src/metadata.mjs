import { failure } from './security.mjs';

const invalid = () => failure(422, 'Confira os metadados enviados.');

// URL parameters remain untrusted data. A canonical own-property object keeps
// idempotency stable without assigning special names to an object's prototype.
export function normalizeMetadata(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.length > 100 || keys.some(key => typeof key !== 'string' || key.length > 128)) throw invalid();
  const entries = keys.sort().map(key => {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
    const item = descriptor.value;
    if (typeof item === 'string' && item.length <= 2048) return [key, item];
    if (Array.isArray(item) && item.length <= 20) {
      const parts = [];
      for (let i = 0; i < item.length; i++) {
        const part = Object.getOwnPropertyDescriptor(item, String(i));
        if (!part || !Object.hasOwn(part, 'value') || typeof part.value !== 'string' || part.value.length > 2048) throw invalid();
        parts.push(part.value);
      }
      return [key, parts];
    }
    throw invalid();
  });
  const metadata = Object.fromEntries(entries);
  if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 16 * 1024) throw invalid();
  return metadata;
}

// Metadata is optional descriptive information. Legacy or damaged storage must
// not turn a management or booking screen into an unhandled parsing failure.
export function readMetadata(json) {
  try { return normalizeMetadata(JSON.parse(typeof json === 'string' && json ? json : '{}')); }
  catch { return {}; }
}
