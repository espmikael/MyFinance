// tema salvo neste aparelho (antes de desenhar a página, para não piscar)
try { const t = localStorage.getItem('caixa-theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
// se o app não aparecer em 12 s (rede caiu, arquivo novo ainda subindo, sessão travada), oferece recarregar em vez de tela vazia
setTimeout(() => {
  const app = document.getElementById('app');
  if (!app || !/^\s*(Carregando…)?\s*$/.test(app.textContent)) return;
  app.innerHTML = '<div class="center"><div class="login"><span class="brand">MyFinance</span><p class="help">Não carregou. Pode ser a internet ou uma atualização do app chegando.</p><button class="btn primary grow" id="mf-reload">Recarregar</button></div></div>';
  document.getElementById('mf-reload').addEventListener('click', () => location.reload());
}, 12000);
