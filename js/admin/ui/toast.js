export function toast(message, icon = 'ℹ') {
  // Se o site já tem uma função global de toast, reutiliza
  if (typeof window.toast === 'function') return window.toast(message, icon);

  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = `${icon} ${message}`;
  Object.assign(el.style, {
    position: 'fixed', right: '1rem', bottom: '1rem', zIndex: '9999',
    background: 'var(--bg-elev, #1a181d)', color: 'var(--text, #eee9e0)',
    padding: '0.7rem 1rem', borderRadius: '8px', border: '1px solid var(--border, #2b272f)',
    boxShadow: '0 8px 24px rgba(0,0,0,0.3)', fontSize: '0.9rem'
  });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}