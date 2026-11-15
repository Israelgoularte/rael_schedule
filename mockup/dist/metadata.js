'use strict';
(() => {
  const errorMessage = 'Este link tem parâmetros demais ou muito longos. Peça um link mais curto para continuar.';
  const invalid = () => new Error(errorMessage);
  function normalize(value) {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if (keys.length > 100 || keys.some(key => typeof key !== 'string' || key.length > 128)) throw invalid();
    const entries = keys.sort().map(key => {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
      const item = descriptor.value;
      if (typeof item === 'string' && item.length <= 2048) return [key, item];
      if (Array.isArray(item) && item.length <= 20 && item.every(part => typeof part === 'string' && part.length <= 2048)) return [key, [...item]];
      throw invalid();
    });
    const metadata = Object.fromEntries(entries);
    if (new TextEncoder().encode(JSON.stringify(metadata)).length > 16 * 1024) throw invalid();
    return metadata;
  }
  function capture(search = '') {
    if (typeof search !== 'string') throw invalid();
    const entries = new Map();
    for (const [key, value] of new URLSearchParams(search)) {
      if (key.length > 128 || value.length > 2048) throw invalid();
      if (!entries.has(key)) {
        if (entries.size >= 100) throw invalid();
        entries.set(key, value);
      }
      else {
        const current = entries.get(key);
        if (Array.isArray(current) && current.length >= 20) throw invalid();
        entries.set(key, Array.isArray(current) ? [...current, value] : [current, value]);
      }
    }
    return normalize(Object.fromEntries(entries));
  }
  function campaign(metadata) {
    return Object.fromEntries(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref_acesso']
      .filter(key => Object.hasOwn(metadata, key)).map(key => [key, metadata[key]]));
  }
  window.RaelMetadata = Object.freeze({ capture, normalize, campaign, errorMessage });
})();
