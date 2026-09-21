/* ============================================================
   CONFIG.JS — Conteúdo padrão do site (fallback)
   ------------------------------------------------------------
   ⚠️ Este arquivo é servido ao navegador.
   NUNCA coloque aqui:
     - SERVICE_ROLE_KEY, JWT_SECRET, MP_ACCESS_TOKEN
     - senhas administrativas
     - chaves de API privadas

   ✅ Pode conter:
     - textos, branding, SEO
     - títulos de seção
     - IDs de planos (mas NÃO preços)
     - redes sociais, aparência

   🎯 Este arquivo é apenas FALLBACK:
     - Quando /api/public falha, o site usa o conteúdo daqui.
     - Quando o backend funciona, o site lê do banco
       (`site_content`, `albums`, `tracks`, `effective_plan`).

   📦 Fonte de verdade (produção):
     - `albums` + `tracks`   → estrutura da discografia
     - `site_content`        → textos, hero, sobre, filosofia, planos, contato, aparência
     - env vars (MP_*)       → preços dos planos

   🚫 Áudios e álbuns NÃO moram aqui.
     Eles vêm de /api/public (albums + tracks) e /api/stream (URLs).

   📦 Uso:
     - Módulos ES:   import { DEFAULT_CONTENT } from './config.js';
     - Código legado: window.DEFAULT_CONTENT
   ============================================================ */

// Bump quando a estrutura mudar de forma incompatível
export const CONTENT_SCHEMA_VERSION = 2;

// ─────────────────────────────────────────────────────────────
// Conteúdo padrão
// ------------------------------------------------------------
// ⚠️ NÃO incluir `discografia.albums` aqui.
//    Álbuns e faixas vêm de `albums` + `tracks` no Supabase.
// ─────────────────────────────────────────────────────────────
export const DEFAULT_CONTENT = {
  branding: {
    name: "Joseph Matthos",
    nameParts: { first: "Joseph", accent: "Matthos" },
    footer: "© 2026 Joseph Matthos. Todos os direitos reservados. ✦ Feito com poesia e beat.",
    meta: {
      title: "Joseph Matthos | Plataforma Oficial",
      description: "Rapper poético, filosófico e inspirador. Discografia completa, prévias gratuitas e loja de faixas individuais."
    },
    bgImage: "assets/img/tema.webp"
  },

  hero: {
    title: "Rimas que<br><span class=\"gold\">pensam.</span>",
    subtitle: "Rapper poético, filosófico e inspirador. Discografia, loja de faixas e assinatura premium.",
    primaryBtn: { text: "▶ Explorar discografia", link: "#discografia" },
    secondaryBtn: { text: "Ver planos", link: "" },
    vinyl: {
      lyric: "\u201cNada acabou. Só estamos começando.\u201d",
      image: "assets/img/vinil.webp"
    }
  },

  sobre: {
    title: "Sobre <span class=\"gold\">Joseph</span>",
    subtitle: "Entre a poesia concreta e o rap de reflexão, uma voz que incomoda e cura.",
    paragraphs: "<strong>Joseph Matthos</strong> não é apenas um rapper. É um cronista do invisível, um filósofo de esquina, um poeta que encontrou no beat a cadência perfeita para suas inquietações.\nNascido na periferia e formado nas ruas, Joseph transforma vivências cruas em letras que equilibram profundidade e acessibilidade.\nCom influências que vão de <strong>Racionais MC's</strong> a <strong>Fernando Pessoa</strong>, ele constrói pontes entre o sagrado e o cotidiano. Em <strong>Boom, Boom, Bàp</strong> (2026), palavras viram rumor, rumor vira verdade e verdade vira legado.",
    quote: "\u201cMinha rima é a filha da noite que pariu o dia.\u201d",
    image: "assets/img/josephmatthos.webp"
  },

  filosofia: {
    title: "Filosofia <span class=\"gold\">em rima</span>",
    subtitle: "Fragmentos de pensamentos que atravessam as letras de Joseph.",
    frases: [
      {
        text: "Haverá dias difíceis, mas a missão continua. Enquanto eu respirar, a história não termina. Nada acabou. Só estamos começando.",
        author: "Boom, Boom, Bàp"
      },
      {
        text: "A rua me ensinou que quem tem pressa de chegar esquece de ver a paisagem.",
        author: "Joseph Matthos"
      },
      {
        text: "Não escrevo para ser entendido. Escrevo para me entender.",
        author: "Joseph Matthos"
      },
      {
        text: "A dor é uma professora severa, mas seus ensinamentos são os mais duradouros.",
        author: "Joseph Matthos"
      },
      {
        text: "Entre o sim e o não, escolhi o talvez — e nele construí minha liberdade.",
        author: "Joseph Matthos"
      }
    ]
  },

  discografia: {
    title: "Disco<span class=\"gold\">grafia</span>",
    subtitle: "Explore álbuns, EPs e singles. Visitantes ouvem prévias de 30s. Assinantes Premium têm acesso completo + downloads."
    // ⚠️ `albums` foi movido para o Supabase (tabelas `albums` + `tracks`).
    //    Vem via /api/public → SITE.albums
  },

  playlists: [
    {
      id: "playlist-inicio",
      title: "O começo",
      description: "Uma seleção para entrar no universo de Joseph.",
      cover: "JM",
      tracks: ["album-bbb:0", "album-bbb:1", "album-1:0"]
    }
  ],

  loja: {
    enabled: true,
    title: "Loja de <span class=\"gold\">faixas</span>",
    subtitle: "Compre músicas individuais. Pagamento único, download imediato, sem assinatura.",
    currency: "BRL",
    discount: { minItems: 3, percent: 10 },
    showCart: true
  },

  planos: {
    title: "Escolha seu <span class=\"gold\">plano</span>",
    subtitle: "Apoie a arte independente e tenha acesso ilimitado a toda a obra de Joseph Matthos.",
    // ⚠️ SEM `price` — preço sempre de /api/plans (envs MP_PREMIUM_*).
    plans: [
      {
        id: "free",
        name: "Visitante",
        desc: "Para conhecer o som de Joseph Matthos.",
        featured: false,
        badge: null,
        features: [
          { text: "Prévias de 30s de todas as faixas", ok: true },
          { text: "Acesso à discografia completa", ok: true },
          { text: "Compra de faixas individuais", ok: true },
          { text: "Faixas completas na assinatura", ok: false },
          { text: "Downloads ilimitados", ok: false }
        ],
        cta: "Plano atual",
        disabled: true
      },
      {
        id: "premium",
        name: "Premium",
        desc: "Experiência completa, sem limites.",
        featured: true,
        badge: "Recomendado",
        features: [
          { text: "Toda a discografia desbloqueada", ok: true },
          { text: "Áudio em alta qualidade", ok: true },
          { text: "Downloads ilimitados", ok: true },
          { text: "Loja de faixas incluída", ok: true },
          { text: "Cancele quando quiser", ok: true }
        ],
        cta: "Assinar Premium",
        disabled: false
      },
      {
        id: "anual",
        name: "Premium Anual",
        desc: "Economize no plano anual.",
        featured: false,
        badge: null,
        features: [
          { text: "Tudo do Premium mensal", ok: true },
          { text: "Desconto anual", ok: true },
          { text: "Acesso antecipado a shows", ok: true },
          { text: "Conteúdo exclusivo do bastidor", ok: true },
          { text: "Badge de apoiador oficial", ok: true }
        ],
        cta: "Assinar Anual",
        disabled: false
      }
    ]
  },

  contato: {
    title: "Conecte-<span class=\"gold\">se</span>",
    subtitle: "Receba letras inéditas, reflexões e datas de shows.",
    heading: "Vamos trocar ideias.",
    description: "Para convites, parcerias ou apenas para compartilhar um verso, me encontre nas redes.",
    socials: [
      { network: "spotify",   url: "https://open.spotify.com/playlist/3flgUEol1uBvFAlriXZE24?si=PtjKfVQuQfms4zMCjyIqaA" },
      { network: "youtube",   url: "https://www.youtube.com/@josephmatthos" },
      { network: "amazon",    url: "https://music.amazon.com.br/artists/B0H7Z173V1/joseph-matthos" },
      { network: "facebook",  url: "https://www.facebook.com/profile.php?id=61593112378384" },
      { network: "tiktok",    url: "https://tiktok.com/@joseph.matthos" },
      { network: "apple",     url: "https://music.apple.com/us/artist/joseph-matthos/6802310570" },
      { network: "audiomack", url: "https://audiomack.com/josephmatthos" }
    ]
  },

  aparencia: {
    bg: "#0b0a0c",
    accent: "#d4af37",
    text: "#eee9e0",
    accentDark: "#8b6f2c",
    border: "#2b272f",
    fontSerif: "'Playfair Display', serif",
    fontSans: "'Inter', sans-serif"
  }
};

// ─────────────────────────────────────────────────────────────
// Labels de redes sociais (network → label)
// ─────────────────────────────────────────────────────────────
export const SOCIAL_LABELS = {
  spotify:   "Spotify",
  youtube:   "YouTube",
  amazon:    "Amazon Music",
  facebook:  "Facebook",
  tiktok:    "TikTok",
  apple:     "Apple Music",
  audiomack: "Audiomack",
  deezer:    "Deezer",
  soundcloud:"SoundCloud",
  instagram: "Instagram",
  x:         "X (Twitter)",
  itunes:    "iTunes"
};

// ─────────────────────────────────────────────────────────────
// Ordem preferencial de exibição das redes no editor
// ─────────────────────────────────────────────────────────────
export const NETWORKS_ORDER = [
  'spotify', 'youtube', 'amazon', 'apple',
  'audiomack', 'deezer', 'soundcloud',
  'facebook', 'instagram', 'tiktok', 'x', 'itunes'
];

// ─────────────────────────────────────────────────────────────
// Formatação de preço (pt-BR / BRL)
// ─────────────────────────────────────────────────────────────
export const PRICE_FORMATTER = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL'
});

// ─────────────────────────────────────────────────────────────
// Congelamento profundo (evita mutação acidental)
// ─────────────────────────────────────────────────────────────
function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const key of Object.keys(obj)) {
      deepFreeze(obj[key]);
    }
  }
  return obj;
}

deepFreeze(DEFAULT_CONTENT);
deepFreeze(SOCIAL_LABELS);
deepFreeze(NETWORKS_ORDER);

// ─────────────────────────────────────────────────────────────
// Compatibilidade com código legado (site.js, store.js)
// ─────────────────────────────────────────────────────────────
if (typeof window !== 'undefined') {
  window.DEFAULT_CONTENT = DEFAULT_CONTENT;
  window.SOCIAL_LABELS = SOCIAL_LABELS;
  window.NETWORKS_ORDER = NETWORKS_ORDER;
  window.PRICE_FORMATTER = PRICE_FORMATTER;
  window.CONTENT_SCHEMA_VERSION = CONTENT_SCHEMA_VERSION;
}
