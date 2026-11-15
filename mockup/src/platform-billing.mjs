// Adding production credentials must never migrate existing test contracts.
// Selection belongs to the provisioned business, not a request or webhook body.
export function platformBillingForTenant(config, slug) {
  const original = config.platformBilling ?? { enabled: false, mode: config.testMode ? 'sandbox' : 'live' };
  const selected = config.entries?.[slug]?.license?.billingMode;
  if (selected === undefined) return original;
  if (selected === 'live' && config.platformBillingLive) return config.platformBillingLive;
  if (selected === original.mode) return original;
  return { enabled: false, mode: selected };
}

export function platformWebhookUrl(config, slug) {
  const billing = platformBillingForTenant(config, slug);
  return billing === config.platformBillingLive ? `${config.origin}/payments/platform/live/webhook` : `${config.origin}/payments/platform/webhook/${slug}`;
}

export function platformCollectorIds(config) {
  return [...new Set([...(config.platformCollectorIds ?? []), config.platformBilling?.collectorId, config.platformBillingLive?.collectorId].filter(value => /^\d{1,32}$/.test(String(value ?? ''))).map(String))];
}
