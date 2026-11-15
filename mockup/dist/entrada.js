const slug = document.body.dataset.business;
const form = document.querySelector('form');
const submit = form.querySelector('[type="submit"]');
const status = form.querySelector('[role="status"]');
const mode = document.body.dataset.mode;

form.addEventListener('submit', async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  if (mode === 'register') {
    const digits = data.phone.replace(/\D/g, '');
    data.phone = [10, 11].includes(digits.length) ? '55' + digits : digits;
  }
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
    location.assign(document.body.dataset.bookings);
  } catch (error) {
    status.textContent = error instanceof TypeError ? 'Falha na conexão. Tente novamente.' : error.message;
  } finally {
    submit.disabled = false;
  }
});
