// tema salvo neste aparelho (antes de desenhar a página, para não piscar)
try { const t = localStorage.getItem('caixa-theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
