const DAY = 86400000;
const stamp = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;

export const tenantCategories = Object.freeze(['trial', 'trial_inactive', 'active', 'expiring', 'inactive', 'inactive30', 'inactive60', 'inactive90', 'closing', 'deletion_wait', 'archived', 'deleted', 'unavailable']);

export function closureFromLifecycle(lifecycle) {
  const summary = typeof lifecycle?.summary_json === 'string' ? JSON.parse(lifecycle.summary_json) : lifecycle?.summary ?? {};
  const closure = summary?.closure;
  return closure && stamp(closure.requestedAt) ? closure : null;
}

// Inactivity measures expired entitlement, not a person's last login. A paid
// future period also protects the account from notices and destructive cleanup.
export function tenantRetention(license, now, { futurePaidUntil = 0, hasPaidHistory = false, lifecycle = null } = {}) {
  const trialUntil = stamp(license?.trialEndsAt), paidUntil = Math.max(stamp(license?.paidUntil), stamp(futurePaidUntil));
  const expiresAt = Math.max(trialUntil, paidUntil) || null;
  const hasCoverage = Boolean(expiresAt && expiresAt > now);
  const inactiveSince = !hasCoverage && expiresAt ? expiresAt : null;
  const inactiveDays = inactiveSince === null ? 0 : Math.max(0, Math.floor((now - inactiveSince) / DAY));
  const closure = closureFromLifecycle(lifecycle);
  let category;
  if (lifecycle?.state === 'deleted') category = 'deleted';
  else if (['archived', 'deleting', 'attention'].includes(lifecycle?.state)) category = 'archived';
  else if (closure) {
    const coveredUntil = Math.max(stamp(closure.coveredUntil), expiresAt ?? 0);
    category = coveredUntil > now ? 'closing' : 'deletion_wait';
  } else if (hasCoverage) {
    category = !hasPaidHistory ? 'trial' : expiresAt - now <= 7 * DAY ? 'expiring' : 'active';
  } else if (inactiveSince === null) category = hasPaidHistory ? 'active' : 'trial';
  else category = inactiveDays >= 90 ? 'inactive90' : inactiveDays >= 60 ? 'inactive60' : inactiveDays >= 30 ? 'inactive30' : hasPaidHistory ? 'inactive' : 'trial_inactive';
  let closureView = null;
  if (closure) {
    const coveredUntil = Math.max(stamp(closure.coveredUntil), expiresAt ?? 0);
    const deleteEligibleAt = Math.max(stamp(closure.deleteEligibleAt), coveredUntil + 7 * DAY);
    closureView = { requestedAt: stamp(closure.requestedAt), coveredUntil, deleteEligibleAt, daysRemaining: Math.max(0, Math.ceil((deleteEligibleAt - now) / DAY)), eligible: now >= deleteEligibleAt, status: coveredUntil > now ? 'closing' : 'deletion_wait' };
  }
  return { category, inactiveSince, inactiveDays, expiresAt, paidUntil: paidUntil || null, hasCoverage, hasPaidHistory: Boolean(hasPaidHistory), hasEverActivated: Boolean(hasPaidHistory), cohort: hasPaidHistory ? 'licensed' : 'trial', closure: closureView };
}

export async function readTenantRetention(db, licenseState, now, lifecycle = null) {
  const [trial] = await db.query('SELECT starts_at, ends_at FROM license_trial WHERE id = 1');
  const [paid] = await db.query('SELECT MAX(ends_at) AS paid_until FROM license_cycles WHERE valid = 1');
  const [money] = await db.query("SELECT COUNT(*) AS total FROM license_money_entries WHERE kind = 'receipt' AND amount_cents > 0");
  const [activated] = await db.query("SELECT COUNT(*) AS total FROM license_cycles WHERE paid_at IS NOT NULL AND amount_cents > 0");
  const [activationAudit] = await db.query("SELECT COUNT(*) AS total FROM audit_events WHERE event_name IN ('platform_license_manual_receipt', 'platform_trial_ended_by_subscription')");
  const futurePaidUntil = stamp(paid?.paid_until);
  return tenantRetention({ ...licenseState, trialEndsAt: Math.max(stamp(licenseState?.trialEndsAt), stamp(trial?.ends_at)) || null }, now, { futurePaidUntil, hasPaidHistory: Number(money?.total ?? 0) > 0 || Number(activated?.total ?? 0) > 0 || Number(activationAudit?.total ?? 0) > 0, lifecycle });
}
