/* Exige login (Supabase Auth) em todas as páginas do protótipo.
 * Sem sessão: vai para login.html e volta para a página pedida depois de entrar.
 * Também liga o ícone de perfil do topo ao "Sair".
 */
(function () {
  'use strict';
  var CFG = window.SUPABASE_CONFIG;
  var sb = window.supabase.createClient(CFG.url, CFG.anonKey);
  window.ERP_SB = sb;

  var raiz = document.currentScript.src.replace(/assets\/guarda\.js.*$/, '');
  var naLogin = /\/login\.html$/.test(location.pathname);

  // a página só aparece depois de confirmar a sessão
  if (!naLogin) document.documentElement.style.visibility = 'hidden';

  window.ERP_SESSAO = sb.auth.getSession().then(function (r) {
    var sessao = r.data && r.data.session;
    if (!sessao && !naLogin) {
      location.replace(raiz + 'login.html?volta=' + encodeURIComponent(location.pathname + location.search));
      return null;
    }
    document.documentElement.style.visibility = '';
    return sessao;
  });

  document.addEventListener('DOMContentLoaded', function () {
    var perfil = document.querySelector('#barra_superior [aria-label="Perfil"]');
    if (!perfil) return;
    window.ERP_SESSAO.then(function (s) { if (s) perfil.title = 'Sair (' + s.user.email + ')'; });
    perfil.addEventListener('click', function (e) {
      e.preventDefault();
      if (!confirm('Sair do sistema?')) return;
      sb.auth.signOut().then(function () { location.replace(raiz + 'login.html'); });
    });
  });
})();
