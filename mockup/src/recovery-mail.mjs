import nodemailer from 'nodemailer';

const settingsError = () => new Error('Configure o SMTP privado de recuperação de senha antes de ativar o envio.');
const tlsCodes = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_UNTRUSTED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ETLS']);
const connectionCodes = new Set(['ECONNECTION', 'ESOCKET', 'ETIMEDOUT', 'EDNS', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE']);

// Only fixed categories and a numeric SMTP status may leave this module. Do
// not forward the provider message/response, AUTH command, recipient or cause.
export function classifyRecoveryMailError(error) {
  const codes = [error?.code, error?.originalCode].filter(code => typeof code === 'string');
  const responseCode = Number.isInteger(error?.responseCode) && error.responseCode >= 400 && error.responseCode <= 599 ? error.responseCode : null;
  const category = codes.some(code => tlsCodes.has(code) || code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_')) ? 'tls'
    : codes.includes('EAUTH') || [530, 534, 535].includes(responseCode) ? 'auth'
      : codes.some(code => connectionCodes.has(code)) ? 'connection'
        : codes.includes('EENVELOPE') || responseCode !== null ? 'rejected' : 'delivery_failed';
  return { category, ...(responseCode === null ? {} : { responseCode }) };
}
const deliveryError = error => Object.assign(new Error('O envio de recuperação está temporariamente indisponível.'), { code: 'RECOVERY_EMAIL_UNAVAILABLE', status: 503, ...classifyRecoveryMailError(error) });
const email = value => typeof value === 'string' && value.length <= 254 && /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(value);
const escape = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const display = (value, fallback, max = 180) => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : fallback;

export function parseRecoveryMail(env = process.env) {
  if (env.RAEL_RECOVERY_EMAIL_ENABLED === undefined || env.RAEL_RECOVERY_EMAIL_ENABLED === '0') return null;
  if (env.RAEL_RECOVERY_EMAIL_ENABLED !== '1') throw settingsError();
  const host = env.RAEL_SMTP_HOST;
  const port = Number(env.RAEL_SMTP_PORT ?? 465);
  const user = env.RAEL_SMTP_USER;
  const password = env.RAEL_SMTP_PASSWORD;
  if (typeof host !== 'string' || host.length > 253 || !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(host) || ![465, 587].includes(port) || !email(user) || typeof password !== 'string' || !password || password.length > 2048 || /[\x00-\x1f\x7f]/.test(password)) throw settingsError();
  return Object.freeze({ host, port, user, password });
}

// There are no attachments, caller-controlled headers, logging or content URLs.
// TLS is mandatory on both supported ports, including certificate validation.
export function recoverySmtpOptions(settings) {
  return {
    host: settings.host, port: settings.port, secure: settings.port === 465,
    requireTLS: true, ignoreTLS: false, opportunisticTLS: false,
    auth: { user: settings.user, pass: settings.password },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: settings.host },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 10000, dnsTimeout: 5000,
    logger: false, debug: false, transactionLog: false,
    disableFileAccess: true, disableUrlAccess: true, maxRecipients: 1,
  };
}

function recoveryUrl(config, raw, kind) {
  try {
    if (typeof raw !== 'string' || raw.length > 1024 || /[\s\x00-\x1f\x7f]/.test(raw)) throw Error();
    const url = new URL(raw), origin = new URL(config.origin);
    const local = !config.production && origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
    if (url.origin !== config.origin || origin.origin !== config.origin || origin.protocol !== 'https:' && !local || url.username || url.password || url.search) throw Error();
    const prefix = kind === 'staff' ? 'sistema' : kind === 'customer' ? 'negocio' : '';
    const match = url.pathname.match(new RegExp(`^/${prefix}/([a-z0-9][a-z0-9-]{1,47})$`));
    if (!prefix || !match || match[1].endsWith('-') || !new RegExp(`^#${kind === 'staff' ? 'recuperar' : 'recuperar-cliente'}=[A-Za-z0-9_-]{43}$`).test(url.hash)) throw Error();
    return url.href;
  } catch { throw deliveryError(); }
}

export function createRecoveryMailer(config, { transport } = {}) {
  const enabled = Boolean(config.recoveryMail);
  const sender = { name: 'Rael Agendamentos', address: config.recoveryMail?.user };
  let smtp;
  const connection = () => smtp ??= transport ?? nodemailer.createTransport(recoverySmtpOptions(config.recoveryMail));
  return Object.freeze({
    enabled,
    async verify() {
      if (!enabled) return { enabled: false };
      try {
        if (await connection().verify() !== true) throw Error();
        return { enabled: true, ready: true };
      } catch (error) { throw deliveryError(error); }
    },
    async send(input) {
      if (!enabled) throw deliveryError();
      const minutes = input?.expiresInMinutes ?? 30;
      if (!input || !email(input.to) || !Number.isInteger(minutes) || minutes < 1 || minutes > 30) throw deliveryError();
      const url = recoveryUrl(config, input.url, input.kind);
      const name = display(input.name, 'Olá', 120), business = display(input.businessName, 'Rael Agendamentos');
      const lifetime = `${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;
      const text = `${name},\n\nRecebemos um pedido para redefinir sua senha em ${business}.\n\nRedefina sua senha: ${url}\n\nEste link é pessoal, funciona uma única vez e expira em ${lifetime}.\nSe você não solicitou a recuperação, ignore esta mensagem. Sua senha continua a mesma.\n\nRael Agendamentos`;
      const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f5f3ed;font-family:Arial,sans-serif;color:#24211b"><main style="max-width:560px;margin:24px auto;padding:28px;background:#fff;border-radius:12px"><p style="font-weight:700">Rael Agendamentos</p><h1 style="font-size:24px">Redefinir sua senha</h1><p>${escape(name)},</p><p>Recebemos um pedido para redefinir sua senha em <strong>${escape(business)}</strong>.</p><p style="margin:28px 0"><a href="${escape(url)}" style="display:inline-block;padding:14px 20px;border-radius:8px;background:#d6ae58;color:#171713;text-decoration:none;font-weight:700">Redefinir minha senha</a></p><p>Este link é pessoal, funciona uma única vez e expira em <strong>${lifetime}</strong>.</p><p>Se você não solicitou a recuperação, ignore esta mensagem. Sua senha continua a mesma.</p><p style="font-size:13px;overflow-wrap:anywhere">Se o botão não abrir, copie este endereço para o navegador:<br>${escape(url)}</p></main></body></html>`;
      try {
        const result = await connection().sendMail({
          from: { ...sender }, to: { name: name === 'Olá' ? '' : name, address: input.to },
          envelope: { from: sender.address, to: [input.to] },
          subject: 'Redefina sua senha · Rael Agendamentos', text, html,
          disableFileAccess: true, disableUrlAccess: true,
        });
        if (!Array.isArray(result?.accepted) || !result.accepted.some(address => String(address).toLowerCase() === input.to.toLowerCase())) throw Object.assign(new Error(), { code: 'EENVELOPE' });
        return { accepted: true };
      } catch (error) { throw deliveryError(error); }
    },
    close() { smtp?.close?.(); },
  });
}
