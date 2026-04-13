// Shared navigation for memex docs
// Include via <script src="/nav.js"></script> at end of <body>
(function() {
  var pages = [
    { href: '/architecture.html', label: 'Architecture' },
    { href: '/dreaming.html', label: 'Dreaming' },
    { href: '/flow.html', label: 'Flow' },
    { href: '/plans/roadmap.html', label: 'Roadmap' },
    { href: '/research/agent-memory-sota-2026.html', label: 'Research' },
  ];

  var current = location.pathname;

  var nav = document.createElement('nav');
  // Build links safely via DOM API (no innerHTML)
  pages.forEach(function(p) {
    var a = document.createElement('a');
    a.href = p.href;
    a.textContent = p.label;
    if (current.endsWith(p.href) || current === p.href) {
      a.className = 'active';
    }
    nav.appendChild(a);
  });

  nav.style.cssText = [
    'position: fixed',
    'top: 0',
    'left: 0',
    'right: 0',
    'z-index: 9999',
    'display: flex',
    'gap: 0',
    'background: #0d1117',
    'border-bottom: 1px solid #30363d',
    'padding: 0 1rem',
    'font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif',
    'font-size: 0.85rem'
  ].join(';');

  var style = document.createElement('style');
  style.textContent = [
    'nav a { color: #8b949e; text-decoration: none; padding: 0.6rem 1rem; transition: color 0.15s, border-color 0.15s; border-bottom: 2px solid transparent; }',
    'nav a:hover { color: #e6edf3; }',
    'nav a.active { color: #58a6ff; border-bottom-color: #58a6ff; }',
    'body { padding-top: 3rem !important; }'
  ].join('\n');

  document.head.appendChild(style);
  document.body.prepend(nav);
})();
