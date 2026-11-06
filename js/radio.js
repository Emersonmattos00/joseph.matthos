/* js/radio.js — Rádio Joseph Matthos (Modo Player) */
'use strict';

let _deps = null;
let _radioActive = false;

export function initRadio(deps) {
  _deps = deps || null;
}

export function openRadioModal() {
  const deps = _deps;
  if (!deps) return;

  if (!deps.isPremium()) {
    alert('A Rádio Joseph Matthos é exclusiva para assinantes Premium.');
    deps.openModal('plansModal');
    return;
  }

  const allTracks = deps.collectAllTracks();
  if (!allTracks.length) {
    alert('Nenhuma faixa publicada disponível para a rádio.');
    return;
  }

  // Embaralha as faixas e salva no sessionStorage para o player ler
  const queue = deps.shuffleArray(allTracks.slice());
  
  // Transforma no padrão de fila do player (albumId e trackId)
  const playerQueue = queue.map(q => ({
    albumId: q.albumId,
    trackId: q.trackId
  }));

  sessionStorage.setItem('radio_queue', JSON.stringify(playerQueue));
  sessionStorage.setItem('radio_index', '0');

  _radioActive = true;
  
  // Redireciona para o player com a flag do modo rádio
  window.location.href = '/player.html?radio=true';
}

export function onRadioTrackEnded() {
  return false; // Tratado internamente no player.js
}

export function syncRadioOnTrackChange() {
  return false;
}

export function isRadioActive() {
  return _radioActive;
}

export function resetRadio() {
  _radioActive = false;
  sessionStorage.removeItem('radio_queue');
  sessionStorage.removeItem('radio_index');
}