const fields = ['tenant', 'clientId', 'collectorId', 'customerId', 'planId', 'expiresAt'];
const lifetime = 2 * 60 * 60 * 1000;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const clock = config => typeof config?.now === 'function' ? config.now() : Date.now();
const liveCollector = (config, id) => [config?.platformBilling, config?.platformBillingLive].some(billing => billing?.mode === 'live' && /^\d{1,32}$/.test(String(billing.collectorId ?? '')) && String(billing.collectorId) === id);

function completeBinding(config, value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key))
    && value.tenant === 'oauth-raelapps'
    && typeof value.clientId === 'string' && /^\d{4,32}$/.test(value.clientId)
    && typeof value.collectorId === 'string' && /^\d{1,32}$/.test(value.collectorId)
    && uuid(value.customerId) && uuid(value.planId)
    && Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0
    && liveCollector(config, value.collectorId));
}

// Only the server environment may introduce this binding. It carries identifiers,
// never credentials, and cannot release a different tenant or receiver.
export function parsePaymentSelfTest(raw, config, loadedAt = Date.now()) {
  if (raw === undefined) return null;
  try {
    if (typeof raw !== 'string' || raw.length > 4096 || !Number.isSafeInteger(loadedAt)) throw Error();
    const value = JSON.parse(raw);
    if (!completeBinding(config, value) || value.expiresAt > loadedAt + lifetime) throw Error();
    return Object.freeze({ ...value });
  } catch { throw new Error('Configuração temporária do teste de recebimento inválida.'); }
}

// Cleanup may inspect the original binding after expiry; it grants no permission
// to create, reconnect or use its credentials for a new operation.
export function selfTestBindingFor(config, slug) {
  const binding = config?.paymentsSelfTest;
  if (!completeBinding(config, binding) || slug !== binding.tenant) return null;
  return Object.freeze({ ...binding });
}

export function selfTestFor(config, slug, now = clock(config)) {
  const binding = selfTestBindingFor(config, slug);
  if (!binding || !Number.isSafeInteger(now) || binding.expiresAt <= now || binding.expiresAt > now + lifetime) return null;
  return binding;
}

export function selfTestCollectorAllowed(config, slug, clientId, collectorId, now = clock(config)) {
  const binding = selfTestFor(config, slug, now);
  return Boolean(binding && binding.clientId === clientId && binding.collectorId === collectorId);
}
