// Apply the saved theme before first paint (kept out of index.html because the CSP forbids inline scripts).
(function () {
  try {
    var t = localStorage.getItem('logo-finder-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked: follow the system theme */ }
})();
