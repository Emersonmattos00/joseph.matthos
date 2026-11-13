const fs = require('fs');
const path = require('path');

const projectRoot = process.cwd();
const playerJsPath = path.join(projectRoot, 'public/js/player.js');
const backupPath = `${playerJsPath}.bak`;

if (!fs.existsSync(playerJsPath)) {
  console.error('❌ Arquivo public/js/player.js não encontrado.');
  process.exit(1);
}

fs.copyFileSync(playerJsPath, backupPath);
console.log(`✅ Backup salvo em: ${backupPath}`);

let content = fs.readFileSync(playerJsPath, 'utf-8');

// ─── 1. Remover e recriar a função tocarMusicaDaLista ───
console.log('🔧 Corrigindo a função tocarMusicaDaLista...');

const regexTocarMusica = /window\.tocarMusicaDaLista\s*=\s*async\s*\(id\)\s*=>\s*\{[\s\S]*?\};/;
const newTocarMusica = `window.tocarMusicaDaLista = async (id) => {
  if (!id) return;
  history.replaceState(null, '', \`/player.html?id=\${encodeURIComponent(id)}\`);
  await initPlayer(id);
};`;

if (regexTocarMusica.test(content)) {
  content = content.replace(regexTocarMusica, newTocarMusica);
  console.log('   ✅ Função tocarMusicaDaLista recriada.');
} else {
  console.log('   ⚠️ Não foi possível encontrar a função tocarMusicaDaLista.');
}

// ─── 2. Remover e recriar os controles do player (play, next, prev) ───
console.log('🔧 Corrigindo os botões de controle...');

const regexPlayerPlay = /window\.playerPlay\s*=\s*\(\)\s*=>\s*\{[\s\S]*?\};/;
const newPlayerPlay = `window.playerPlay = () => {
  if (!audio.src) { if (currentTrackId) initPlayer(currentTrackId); return; }
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
};`;

if (regexPlayerPlay.test(content)) {
  content = content.replace(regexPlayerPlay, newPlayerPlay);
  console.log('   ✅ Função playerPlay recriada.');
}

const regexPlayerNext = /window\.playerNext\s*=\s*\(\)\s*=>\s*\{[\s\S]*?\};/;
const newPlayerNext = `window.playerNext = () => {
  if (!currentTrackMeta?.albumTracks) return;
  const tracks = currentTrackMeta.albumTracks;
  const index = tracks.findIndex(t => String(t.id) === String(currentTrackId));
  if (index < 0) return;
  const next = tracks[(index + 1) % tracks.length];
  if (next?.id) window.tocarMusicaDaLista(String(next.id));
};`;

if (regexPlayerNext.test(content)) {
  content = content.replace(regexPlayerNext, newPlayerNext);
  console.log('   ✅ Função playerNext recriada.');
}

const regexPlayerPrev = /window\.playerPrev\s*=\s*\(\)\s*=>\s*\{[\s\S]*?\};/;
const newPlayerPrev = `window.playerPrev = () => {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (!currentTrackMeta?.albumTracks) return;
  const tracks = currentTrackMeta.albumTracks;
  const index = tracks.findIndex(t => String(t.id) === String(currentTrackId));
  if (index < 0) return;
  const prev = tracks[(index - 1 + tracks.length) % tracks.length];
  if (prev?.id) window.tocarMusicaDaLista(String(prev.id));
};`;

if (regexPlayerPrev.test(content)) {
  content = content.replace(regexPlayerPrev, newPlayerPrev);
  console.log('   ✅ Função playerPrev recriada.');
}

// ─── 3. Corrigir a função renderPlayerTrackList ───
console.log('🔧 Corrigindo a função renderPlayerTrackList...');

// Encontra o inicio da função renderPlayerTrackList
const startFunc = content.indexOf('function renderPlayerTrackList(meta, currentId) {');
if (startFunc !== -1) {
  // Encontra o final da função (a próxima chave de fechamento de função)
  const endFunc = content.indexOf('\n}', startFunc) + 2;
  
  const newRenderList = `function renderPlayerTrackList(meta, currentId) {
  if (!els.musicList) return;
  els.musicList.replaceChildren();
  
  if (els.albumHeaderCount) {
    els.albumHeaderCount.textContent = \`\${meta.albumTracks.length} faixas\`;
  }

  meta.albumTracks.forEach((track, index) => {
    const item = document.createElement('div');
    item.className = 'music-item';
    if (String(track.id) === String(currentId)) item.classList.add('playing');

    const number = document.createElement('div');
    number.className = 'music-item-number';
    number.innerHTML = \`<span class="num-text">\${index + 1}</span><span class="play-hover">▶</span>\`;

    const info = document.createElement('div');
    info.className = 'music-item-info';

    const title = document.createElement('div');
    title.className = 'music-item-title';
    title.textContent = track.title || 'Faixa sem título';

    const artist = document.createElement('div');
    artist.className = 'music-item-artist';
    artist.innerHTML = \`\${esc(meta.artist || 'Joseph Matthos')} \${track.isrc ? \`<span class="music-item-isrc">ISRC: \${esc(track.isrc)}</span>\` : ''}\`;

    info.append(title, artist);

    const actions = document.createElement('div');
    actions.className = 'music-item-actions';

    const likeBtn = document.createElement('button');
    likeBtn.className = 'action-icon';
    const key = \`jm_like_\${meta.id}_\${index}\`;
    const isLiked = localStorage.getItem(key) === '1';
    likeBtn.innerHTML = \`<svg viewBox="0 0 24 24" width="18" height="18" fill="\${isLiked ? '#1DB954' : 'none'}" stroke="\${isLiked ? '#1DB954' : 'currentColor'}" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>\`;
    likeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const liked = localStorage.getItem(key) === '1';
      localStorage.setItem(key, liked ? '0' : '1');
      likeBtn.innerHTML = \`<svg viewBox="0 0 24 24" width="18" height="18" fill="\${!liked ? '#1DB954' : 'none'}" stroke="\${!liked ? '#1DB954' : 'currentColor'}" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>\`;
      showToast(liked ? 'Removido dos curtidos' : 'Curtido!');
    });
    actions.appendChild(likeBtn);

    const shareBtn = document.createElement('button');
    shareBtn.className = 'action-icon';
    shareBtn.innerHTML = \`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>\`;
    shareBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const url = \`\${location.origin}/player.html?id=\${encodeURIComponent(track.id)}\`;
      const shareData = { title: \`\${track.title} — Joseph Matthos\`, text: \`Ouça "\${track.title}"\`, url };
      if (navigator.share) { try { await navigator.share(shareData); return; } catch {} }
      try { await navigator.clipboard.writeText(url); showToast('Link copiado!'); }
      catch { showToast('Não foi possível compartilhar.'); }
    });
    actions.appendChild(shareBtn);

    const rentBtn = document.createElement('button');
    rentBtn.className = 'action-icon';
    rentBtn.innerHTML = \`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12c0-1.1.9-2 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-1.99.9-1.99 2v4c1.1 0 1.99.9 1.99 2s-.89 2-2 2v4c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-4c-1.1 0-2-.9-2-2z"/><path d="M9 10v4M15 10v4"/></svg>\`;
    rentBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.location.href = \`/?rent=\${encodeURIComponent(track.id)}\`;
    });
    actions.appendChild(rentBtn);

    const duration = document.createElement('span');
    duration.className = 'music-item-duration';
    duration.textContent = track.locked ? '🔒' : track.durationSeconds ? formatTime(track.durationSeconds) : '--:--';
    actions.appendChild(duration);

    const moreBtn = document.createElement('button');
    moreBtn.className = 'action-icon';
    moreBtn.innerHTML = \`<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>\`;
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openOptionsMenu(track, meta, index, moreBtn);
    });
    actions.appendChild(moreBtn);

    item.append(number, info, actions);
    item.addEventListener('click', () => window.tocarMusicaDaLista(String(track.id)));
    els.musicList.appendChild(item);
  });
}`;

  content = content.slice(0, startFunc) + newRenderList + content.slice(endFunc);
  console.log('   ✅ Função renderPlayerTrackList recriada.');
} else {
  console.log('   ⚠️ Não foi possível encontrar a função renderPlayerTrackList.');
}

// ─── 4. Corrigir a função abrirAlbum para não quebrar o player ───
console.log('🔧 Corrigindo a função abrirAlbum...');

const regexAbrirAlbum = /window\.abrirAlbum\s*=\s*async\s*\(albumId\)\s*=>\s*\{[\s\S]*?\};/;
const newAbrirAlbum = `window.abrirAlbum = async (albumId) => {
  const header = document.getElementById('albumTracklistHeader');
  const list = document.getElementById('musicList');
  if (header) header.style.display = 'flex';
  if (list) list.innerHTML = '<p style="text-align:center;color:#aaa;">Carregando faixas...</p>';

  switchTab('music');

  try {
    const res = await fetch(\`/api/public?album=\${albumId}&t=\${Date.now()}\`, { cache: 'no-store' });
    const data = await res.json();
    
    if (!data.ok || !data.album) throw new Error(data.error || 'Álbum não encontrado.');

    const album = data.album;
    const tracks = album.tracks || [];

    currentTrackMeta = { ...album, albumTracks: tracks };
    
    if (els.albumHeaderCover) els.albumHeaderCover.style.backgroundImage = \`url('\${album.coverUrl}')\`;
    if (els.albumHeaderTitle) els.albumHeaderTitle.textContent = album.title;
    if (els.albumHeaderArtist) els.albumHeaderArtist.textContent = album.artist || 'Joseph Matthos';
    if (els.albumHeaderCount) els.albumHeaderCount.textContent = \`\${tracks.length} faixas\`;

    renderPlayerTrackList(currentTrackMeta, currentTrackId);
    
  } catch (err) {
    if (list) list.innerHTML = \`<p style="color:var(--danger);text-align:center;">\${esc(err.message)}</p>\`;
  }
};`;

if (regexAbrirAlbum.test(content)) {
  content = content.replace(regexAbrirAlbum, newAbrirAlbum);
  console.log('   ✅ Função abrirAlbum recriada.');
} else {
  console.log('   ⚠️ Não foi possível encontrar a função abrirAlbum.');
}

// ─── 5. Salvar ───
fs.writeFileSync(playerJsPath, content, 'utf-8');
console.log('\n🎉 Concluído! Faça o commit e o push.');