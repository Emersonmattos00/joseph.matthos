export function openAdminModal(html) {
  const content = document.getElementById('adminModalContent');
  const modal = document.getElementById('adminModal');
  if (!content || !modal) return;
  content.innerHTML = html;
  modal.classList.add('open');
}

export function closeAdminModal() {
  const modal = document.getElementById('adminModal');
  if (modal) modal.classList.remove('open');
}

// Fecha ao clicar fora
document.addEventListener('click', (e) => {
  const modal = document.getElementById('adminModal');
  if (modal && modal.classList.contains('open') && e.target === modal) closeAdminModal();
});

window.closeAdminModal = closeAdminModal; // compatibilidade com onclick inline legado