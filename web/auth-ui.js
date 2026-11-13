(() => {
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;

  const style = document.createElement('style');
  style.textContent = `#auth-dialog{width:min(420px,calc(100% - 32px));border:1px solid #2a3b35;border-radius:12px;background:#16231f;color:#e8f0ec;padding:24px;box-shadow:0 20px 70px #0009}#auth-dialog::backdrop{background:#06100ddd;backdrop-filter:blur(5px)}#auth-dialog h2{margin:0 0 8px;font-size:20px}#auth-dialog p{color:#93a69d;font-size:13px;line-height:1.55}#auth-dialog label{display:block;margin:18px 0 6px;font-size:12px;font-weight:600}#auth-dialog input{width:100%;min-height:42px;padding:10px;border:1px solid #2a3b35;border-radius:7px;background:#0f1815;color:#e8f0ec}#auth-dialog button{width:100%;margin-top:14px;padding:11px;border:0;border-radius:7px;background:#f2b705;color:#2a2100;font-weight:700;cursor:pointer}#auth-dialog #auth-close{background:transparent;color:#93a69d;border:1px solid #2a3b35}#auth-error{min-height:18px;color:#ff9a73;font-size:12px}`;
  document.head.append(style);
  document.body.insertAdjacentHTML('beforeend', `<dialog id="auth-dialog" aria-labelledby="auth-title"><form id="auth-form"><h2 id="auth-title">Monitor de promoções</h2><p id="auth-description">Entre com a senha de acesso para ver seus monitoramentos.</p><label for="auth-password">Senha</label><input id="auth-password" type="password" autocomplete="current-password" required><div id="auth-error" role="alert"></div><button type="submit">Entrar</button><button id="auth-close" type="button">Fechar</button></form></dialog>`);

  const dialog = document.getElementById('auth-dialog');
  const form = document.getElementById('auth-form');
  const error = document.getElementById('auth-error');
  const password = document.getElementById('auth-password');
  document.getElementById('auth-close').addEventListener('click', () => dialog.close());
  const nativeFetch = window.fetch.bind(window);

  function show(message = '') {
    error.textContent = message;
    if (!dialog.open) dialog.showModal();
    password.focus();
  }

  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    if (requestUrl && new URL(requestUrl, location.href).pathname.startsWith('/api/') && response.status === 401) show();
    return response;
  };

  nativeFetch('/api/auth', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    .then(response => response.json())
    .then(state => {
      if (!state.configured) {
        document.getElementById('auth-description').textContent = 'Configure APP_PASSWORD, SESSION_SECRET e DATABASE_URL nas variáveis de ambiente do projeto para ativar a aplicação.';
        password.disabled = true;
        form.querySelector('button').disabled = true;
        show('A configuração inicial ainda está pendente.');
      } else if (!state.authenticated) show();
    })
    .catch(() => show('Não foi possível conectar à API.'));

  form.addEventListener('submit', async event => {
    event.preventDefault();
    error.textContent = '';
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const response = await nativeFetch('/api/auth', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ password: password.value })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Não foi possível entrar.');
      password.value = '';
      dialog.close();
      window.dispatchEvent(new Event('promotions:auth'));
    } catch (cause) {
      error.textContent = cause.message || 'Falha na autenticação.';
    } finally {
      button.disabled = false;
    }
  });

  const logout = document.createElement('button');
  logout.type = 'button';
  logout.className = 'btn secondary';
  logout.textContent = 'Sair';
  logout.setAttribute('aria-label', 'Encerrar sessão');
  logout.addEventListener('click', async () => {
    try { await nativeFetch('/api/auth', { method: 'DELETE', credentials: 'same-origin' }); } finally { show('Sessão encerrada.'); }
  });
  document.querySelector('header')?.append(logout);
})();
