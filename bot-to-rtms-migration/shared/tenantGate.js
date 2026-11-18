import path from 'node:path';

/**
 * Tenant and consent gate.
 *
 * RTMS is authorization-policy heavy: unlike a Meeting SDK service account, every
 * stream is tied to an installed app user, an admin policy and a consent decision.
 * The gate answers one question before a stream is opened or an artifact written:
 * "does this account have a tenant, and does the tenant permit this product and media?"
 *
 * Tenant record (plain data; load it from your own configuration):
 *   tenantId, accountIds[], status: active | suspended | revoked
 *   products[]            meeting | webinar | videoSdk | contactCenter
 *   media[]               audio | video | share | transcript | chat
 *   installedUserIds[]    app users who installed or authorized the app
 *   approvedHostDomains[] optional audit list for external meetings
 *   consentRef            reference to the consent artifact, never inferred from stream existence
 *   policyVersion, retentionClass
 */
export function createTenantGate(tenants = []) {
  const byId = new Map();
  const byAccount = new Map();

  function add(tenant) {
    const record = { status: 'active', products: [], media: [], installedUserIds: [], approvedHostDomains: [], ...tenant };
    byId.set(record.tenantId, record);
    for (const accountId of record.accountIds || []) byAccount.set(accountId, record.tenantId);
    return record;
  }
  for (const t of tenants) add(t);

  function resolve(accountId) {
    const id = byAccount.get(accountId);
    return id ? byId.get(id) : null;
  }

  function check({ accountId, product, media = [] }) {
    const tenant = resolve(accountId);
    if (!tenant) return { ok: false, reason: 'unknown_account' };
    if (tenant.status !== 'active') return { ok: false, reason: `tenant_${tenant.status}`, tenantId: tenant.tenantId };
    if (!tenant.products.includes(product)) return { ok: false, reason: 'product_not_enabled', tenantId: tenant.tenantId };
    const missing = media.filter((m) => !tenant.media.includes(m));
    if (missing.length) return { ok: false, reason: 'media_not_enabled', missing, tenantId: tenant.tenantId };
    if (!tenant.consentRef) return { ok: false, reason: 'missing_consent_ref', tenantId: tenant.tenantId };
    return {
      ok: true,
      tenantId: tenant.tenantId,
      consentRef: tenant.consentRef,
      policyVersion: tenant.policyVersion || null,
      retentionClass: tenant.retentionClass || 'default'
    };
  }

  /** Stop reason 8 (revoked) and tenant offboarding both land here. */
  function revoke(tenantId, reason = 'revoked') {
    const tenant = byId.get(tenantId);
    if (!tenant) return false;
    tenant.status = 'revoked';
    tenant.revokedReason = reason;
    return true;
  }

  /** Tenant-scoped storage prefix. Rejects traversal so one tenant cannot reach another's path. */
  function tenantPath(tenantId, ...parts) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(tenantId))) throw new Error('invalid_tenant_id');
    for (const part of parts) {
      if (String(part).includes('..') || path.isAbsolute(String(part))) throw new Error('invalid_path_part');
    }
    return path.posix.join(`tenant=${tenantId}`, ...parts.map(String));
  }

  return { add, resolve, check, revoke, tenantPath, get: (id) => byId.get(id) || null, list: () => [...byId.values()] };
}
