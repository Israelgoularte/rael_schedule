import { failure } from './security.mjs';

export const legalVersions = Object.freeze({ terms: '2026-10-26.1', privacy: '2026-10-26.1' });

// Agreement to the service terms is distinct from consent for optional marketing.
// This record never authorizes marketing, email campaigns or unrelated sharing.
export function requireLegalAcceptance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['accepted', 'termsVersion', 'privacyVersion'].includes(key))
      || value.accepted !== true || value.termsVersion !== legalVersions.terms || value.privacyVersion !== legalVersions.privacy) {
    throw failure(422, 'Leia e aceite os Termos de Uso e confira a Política de Privacidade antes de solicitar seu acesso.');
  }
  return { termsVersion: legalVersions.terms, privacyVersion: legalVersions.privacy, method: 'explicit_checkbox' };
}
