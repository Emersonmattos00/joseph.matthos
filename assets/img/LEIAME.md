# 🖼 Imagens da Plataforma

Esta pasta contém as imagens usadas no site. Se alguma faltar, o site
**não quebra**: exibe o fallback (iniciais "JM" / vinil dourado padrão)
e avisa no console do navegador.

---

## 📋 Arquivos necessários

| Arquivo | Onde aparece | Dimensões ideais | Formato |
|---------|--------------|------------------|---------|
| `josephmatthos.png` | Seção **Sobre** (retrato vertical) | 800 × 1067 px (3:4) | PNG / WebP |
| `tema.png` | Fundo geral do site (banner panorâmico) | 1920 × 1080 px (16:9) | PNG / WebP |
| `vinil.png` | Vinil giratório da hero | 1000 × 1000 px (quadrada) | PNG / WebP |
| `album-boom-boom-bap.jpg` | Capa do álbum na discografia + `og:image` | 1000 × 1000 px (quadrada) | JPG / WebP |

---

## ⚙️ Como adicionar

1. Salve o arquivo com o **nome exato** da tabela acima
2. Coloque **nesta pasta** (`assets/img/`)
3. Recarregue o site — deve aparecer automaticamente

**Se a imagem não aparecer:**
- Abra o DevTools (F12) → aba **Console**
- Procure por `Imagem não encontrada: assets/img/...`
- Confirme que o nome do arquivo bate exatamente (maiúsculas/minúsculas importam)
- Confirme que a extensão é `.jpg` (não `.jpeg` nem `.JPG`)

---

## 🔄 Como trocar depois

### ✅ Opção A — Pelo painel admin (mais fácil)

1. `Ctrl + Shift + A` → login
2. Vá em **Geral**, **Hero** ou **Sobre** conforme a imagem
3. Cole a URL **ou** clique em **📁 Enviar arquivo**
   - Imagens enviadas são redimensionadas para 1920px e comprimidas em JPG automaticamente
4. **💾 Salvar alterações**

### ✏️ Opção B — Editando `js/config.js`

```js
branding: {
  bgImage: "assets/img/tema.png"              // fundo geral
},
hero: {
  vinylImage: "assets/img/vinil.png"                 // vinil
},
sobre: {
  image: "assets/img/josephmatthos.png"       // retrato
}
```

---

## 🎨 Otimização

Antes de subir imagens, comprima em [squoosh.app](https://squoosh.app):

- **Formato:** WebP (30–50% menor) ou JPG
- **Qualidade:** 80–85%
- **Peso alvo:** < 300 KB por imagem
- **Metadata:** remover EXIF (o Squoosh faz por padrão)

### Redimensionamento por contexto

| Imagem | Máximo recomendado |
|--------|--------------------|
| `hero-bg.jpg` | 1920 px de largura |
| `joseph-sobre.jpg` | 1000 px de largura |
| Capas de álbum | 1000 × 1000 px |
| Vinil (hero) | 1000 × 1000 px |

---

## ⚠️ Aviso sobre cache em produção

O `vercel.json` define cache de **7 dias** para `/assets/img/`.

**Isso significa:** se você **trocar uma imagem mantendo o mesmo nome**,
visitantes recorrentes podem ver a versão antiga por até 7 dias.

### Como forçar atualização

- **Rápido:** renomeie com data — `hero-bg-2026-02.jpg`
- **Limpo:** versionar todos os arquivos — `hero-bg-v2.jpg`
- **Definitivo:** usar hash de conteúdo — `hero-bg-a3f9c2.jpg`

Depois de renomear, atualize a referência no `config.js` (ou no painel admin).

---

## 📸 Origem das imagens

Todas as imagens são de propriedade do artista. Se você é fã e quer
sugerir alguma foto oficial, entre em contato pelas redes sociais.

---

## 🆘 Problemas comuns

### "A imagem aparece distorcida"
→ Verifique a **proporção** esperada (3:4 para Sobre, 1:1 para capas).

### "A imagem está cortada de forma estranha"
→ O CSS usa `background-size: cover` — a imagem é recortada para preencher o espaço. Posicione o elemento central (rosto, logo) no **centro** da imagem.

### "A imagem do og:image não aparece no WhatsApp"
→ O `og:image` precisa ser **URL absoluta** em produção (ex.: `https://seudominio.com/assets/img/album-boom-boom-bap.jpg`). Edite `index.html` no `<head>`.

### "A imagem some depois de trocar no admin"
→ O admin salva no `localStorage` **apenas no seu navegador**. Para publicar para todos, edite os arquivos e faça commit + push.