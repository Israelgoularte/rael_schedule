'use strict';
(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const requests = new WeakMap();
  const confirmation = 'Se houver um acesso disponível para este e-mail, enviaremos um link de recuperação. Confira também a caixa de spam.';
  const validEmail = value => value.length <= 254 && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  function show({ dialog, email = '', businessName = '', titleId = 'email-recovery-title', send }) {
    if (!dialog || typeof send !== 'function') return;
    const previous = requests.get(dialog);
    if (previous) previous.cleanup(false);
    const opener = document.activeElement, previousClassName = dialog.className || '';
    const state = { pending: false, done: false, closed: false, cleanup: null };
    requests.set(dialog, state);
    dialog.className = 'recovery-email-dialog';
    dialog.innerHTML = `<button class="dialog-close" type="button" data-recovery-close aria-label="Fechar recuperação de senha">×</button><h2 id="${esc(titleId)}">Recuperar minha senha</h2>${businessName ? `<p class="small muted recovery-business">${esc(businessName)}</p>` : ''}<p class="spaced">Informe o e-mail cadastrado no seu acesso para receber um link de recuperação.</p><form id="email-recovery-form"><label class="field" for="recovery-email"><span>E-mail do seu cadastro</span><input id="recovery-email" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" maxlength="254" value="${esc(String(email).slice(0, 254))}" required></label><p id="recovery-feedback" class="small recovery-feedback" role="status" aria-live="polite" tabindex="-1"></p><p class="small muted">O link vale por 30 minutos e pode ser usado uma única vez.</p><div class="recovery-actions spaced"><button class="button" type="submit">Enviar link por e-mail</button><button class="button secondary" type="button" data-recovery-close>Voltar para entrar</button></div></form>`;
    const form = dialog.querySelector('#email-recovery-form'), input = dialog.querySelector('#recovery-email'), feedback = dialog.querySelector('#recovery-feedback'), submit = form.querySelector('[type=submit]');
    function current() { return !state.closed && requests.get(dialog) === state && dialog.open && form.isConnected !== false; }
    function cleanup(restoreFocus = true) {
      if (state.closed) return;
      state.closed = true;
      dialog.removeEventListener('submit', onSubmit, true);
      dialog.removeEventListener('click', onClick, true);
      dialog.removeEventListener('close', onClose);
      if (requests.get(dialog) === state) {
        requests.delete(dialog);
        dialog.className = previousClassName;
        dialog.innerHTML = '';
      }
      if (restoreFocus && opener?.isConnected !== false) opener?.focus();
    }
    state.cleanup = cleanup;
    function onClose() { cleanup(); }
    function onClick(event) {
      if (!event.target.closest('[data-recovery-close]')) return;
      event.preventDefault(); event.stopImmediatePropagation();
      dialog.close(); cleanup();
    }
    async function onSubmit(event) {
      if (event.target !== form) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (state.pending || state.done || !current()) return;
      const value = input.value.trim().toLowerCase();
      feedback.classList.remove('error');
      if (!validEmail(value)) { feedback.textContent = 'Informe um e-mail válido, com até 254 caracteres.'; input.focus(); return; }
      state.pending = true; submit.disabled = true; input.readOnly = true; submit.textContent = 'Solicitando link…'; feedback.textContent = ''; form.setAttribute('aria-busy', 'true');
      try {
        await send({ email: value });
        if (!current()) return;
        state.done = true;
        feedback.textContent = confirmation;
        submit.textContent = 'Solicitação concluída';
        feedback.focus();
      } catch (error) {
        if (!current()) return;
        feedback.classList.add('error');
        feedback.textContent = error.status === 429 ? 'Muitas solicitações. Aguarde alguns minutos antes de tentar novamente.' : error.status === 503 ? 'O envio de e-mail está temporariamente indisponível. Tente novamente mais tarde ou peça ajuda ao responsável.' : 'Não foi possível solicitar o link. Confira sua conexão e tente novamente.';
        submit.disabled = false; input.readOnly = false; submit.textContent = 'Tentar enviar novamente'; feedback.focus();
      } finally {
        state.pending = false;
        if (current()) form.removeAttribute('aria-busy');
      }
    }
    dialog.addEventListener('submit', onSubmit, true);
    dialog.addEventListener('click', onClick, true);
    dialog.addEventListener('close', onClose);
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
    input.focus();
  }
  window.RaelRecovery = { show };
})();
