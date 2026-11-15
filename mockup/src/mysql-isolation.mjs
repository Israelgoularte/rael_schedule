// Hosting database grants may interpret an unescaped underscore as one character.
// Reject overlapping names conservatively; this does not replace SHOW GRANTS or
// a cross-account access audit. Hostinger identifiers use only ASCII letters,
// digits and underscores. No DNS lookup or connection is performed here.
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(value);
const host = value => {
  const name = String(value ?? '').toLowerCase().replace(/\.$/, '');
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(name) ? 'loopback' : name;
};
export function databaseNamesOverlap(left, right) {
  if (!identifier(left) || !identifier(right)) return true;
  const a = left.toLowerCase(), b = right.toLowerCase();
  const matches = (pattern, name) => pattern.length === name.length && [...pattern].every((char, index) => char === '_' || char === name[index]);
  return matches(a, b) || matches(b, a);
}
export function mysqlEntriesConflict(left, right) {
  if (left?.driver !== 'mysql' || right?.driver !== 'mysql' || host(left.host) !== host(right.host) || Number(left.port ?? 3306) !== Number(right.port ?? 3306)) return false;
  return String(left.user).toLowerCase() === String(right.user).toLowerCase() || databaseNamesOverlap(left.database, right.database);
}
