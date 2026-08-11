// Shared dev navigation for all Hog Wild pages — works in EVERY environment
// (owner requirement): localhost AND GitHub Pages project sites, which serve
// from a subpath (/ava-games/). All links are built against a dynamically
// computed site root, so nothing here assumes it lives at /.
// One source of truth: add new pages to PAGES and every page gets the link.
// On the game page it renders as a discreet 🛠 button that expands;
// everywhere else it's a compact fixed bar, top-right.
(function () {
  const PAGES = [
    { href: '_watch/',                        label: '📊 dashboard' },
    { href: 'hog-wild/',                      label: '🎮 game' },
    { href: '_watch/arena.html',              label: '🏟 arena' },
    { href: '_watch/poses.html',              label: '🖼 pose gallery' },
    { href: 'hog-wild/dev/pig-viewer.html',   label: '🐖 pig viewer' },
    { href: 'hog-wild/dev/audio-lab.html',    label: '🔊 audio lab' },
    { href: 'hog-wild/dev/shake-test.html',   label: '🤳 shake test' },
  ];

  // Site root = everything before the deepest known segment in the path.
  const path = location.pathname;
  const m = path.match(/^(.*?)(?:_watch|hog-wild)\//);
  const base = m ? m[1] : '/';
  PAGES.forEach(p => p.href = base + p.href);

  const here = path.replace(/index\.html$/, '');
  const isGame = here === base + 'hog-wild/';

  const css = document.createElement('style');
  css.textContent = `
    #devnav{position:fixed;z-index:99999;font:12px/1 ui-monospace,Menlo,monospace}
    #devnav a{color:#a9c9b8;text-decoration:none;display:block;padding:7px 12px;
      border-radius:8px;white-space:nowrap}
    #devnav a:hover{background:#27473a;color:#fff}
    #devnav a.cur{color:#ffd54a;font-weight:bold}
    #devnav .bar{display:flex;gap:2px;background:#101b15ee;border:1px solid #2a4636;
      border-radius:10px;padding:3px;backdrop-filter:blur(4px)}
    #devnav.corner{left:10px;bottom:10px}
    #devnav.corner .menu{display:none;flex-direction:column;gap:2px;background:#101b15f5;
      border:1px solid #2a4636;border-radius:12px;padding:6px;margin-bottom:6px}
    #devnav.corner.open .menu{display:flex}
    #devnav.corner button{width:38px;height:38px;border-radius:50%;border:1px solid #2a4636;
      background:#101b15dd;color:#a9c9b8;font-size:17px;cursor:pointer;display:block}
    #devnav.corner button:hover{background:#27473a}
    #devnav.top{right:10px;top:10px}
    @media (max-width:700px){ #devnav.top .bar{flex-wrap:wrap;max-width:52vw;justify-content:flex-end} }
  `;
  document.head.appendChild(css);

  const nav = document.createElement('nav');
  nav.id = 'devnav';
  const links = PAGES.map(p =>
    `<a href="${p.href}" class="${p.href.replace(/index\.html$/, '') === here ? 'cur' : ''}">${p.label}</a>`).join('');

  if (isGame) {
    nav.className = 'corner';
    nav.innerHTML = `<div class="menu">${links}</div><button title="dev tools" aria-label="dev tools">🛠</button>`;
    nav.querySelector('button').onclick = () => nav.classList.toggle('open');
    document.addEventListener('click', e => { if (!nav.contains(e.target)) nav.classList.remove('open'); });
  } else {
    nav.className = 'top';
    nav.innerHTML = `<div class="bar">${links}</div>`;
  }
  document.body.appendChild(nav);
})();
