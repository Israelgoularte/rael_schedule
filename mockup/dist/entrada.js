const slug = document.body.dataset.business;
const form = document.querySelector('form');
const signupFields = form.querySelector('fieldset');
const password = form.elements.password;
const submit = form.querySelector('[type="submit"]');
const status = form.querySelector('[role="status"]');
const modes = [...document.querySelectorAll('[data-mode]')];
const recovery = document.querySelector('#recovery');
let mode = 'login';

for (const button of modes) {
  button.addEventListener('click', () => {
    mode = button.dataset.mode;
    const registering = mode === 'register';
    signupFields.hidden = signupFields.disabled = !registering;
    recovery.hidden = registering;
    password.autocomplete = registering ? 'new-password' : 'current-password';
    password.minLength = registering ? 8 : 0;
    submit.textContent = button.textContent;
    status.textContent = '';
    for (const option of modes) option.setAttribute('aria-pressed', String(option === button));
  });
}

for (const link of document.querySelectorAll('[data-open]')) {
  link.addEventListener('click', () => modes.find(button => button.dataset.mode === link.dataset.open)?.click());
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  if (mode === 'register') {
    const digits = data.phone.replace(/\D/g, '');
    data.phone = [10, 11].includes(digits.length) ? '55' + digits : digits;
  }
  for (const button of modes) button.disabled = true;
  submit.disabled = true;
  status.textContent = '';
  try {
    const response = await fetch('/internal/' + slug + '/customer/' + mode, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || 'Não foi possível acessar a agenda.');
    }
    location.assign('/negocio/' + slug + '?visao=agendamentos');
  } catch (error) {
    status.textContent = error instanceof TypeError ? 'Falha na conexão. Tente novamente.' : error.message;
  } finally {
    for (const button of modes) button.disabled = false;
    submit.disabled = false;
  }
});
