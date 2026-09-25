-- ═══════════════════════════════════════════════════════════════════════
--  JOSEPH MATTHOS — schema.sql
--  ---------------------------------------------------------------
--  Estrutura completa do banco (Supabase / PostgreSQL)
--
--  Ordem de criação:
--    01. profiles
--    02. albums
--    03. tracks
--    04. subscriptions
--    05. payments_attempts
--    06. payments_events
--    07. rentals
--    08. site_content
--    09. site_content_history
--    10. admin_audit
--    11. auth_audit_log
--    12. view effective_plan
--    13. grants
--    14. reload PostgREST
--    15. policies service_role (tabelas)
--    16. migração de áudio (full_audio → full_path)
--    17. STORAGE — policies (buckets via Dashboard)
--    18. reload PostgREST (final)
--    19. STATS — contador de plays por faixa
--
--  Idempotente: pode ser rodado várias vezes sem erro.
--
--  ⚠️  IMPORTANTE — BUCKETS DE STORAGE
--  ---------------------------------------------------------------
--  Os 3 buckets (site-assets, audio-preview, audio-premium) NÃO
--  são criados por este SQL. A role do SQL Editor não tem permissão
--  de owner sobre `storage.buckets` (essa tabela pertence à role
--  interna `supabase_storage_admin`).
--
--  Crie-os manualmente pelo Dashboard do Supabase:
--     Storage → New bucket
--  Veja a seção 17 para os parâmetros exatos.
-- ═══════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════
--  01. profiles — dados públicos do usuário (NÃO guarda plano)
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null default '',
  name        text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.profiles is
  'Dados públicos do usuário. Plano vive em subscriptions; plano efetivo em effective_plan.';
comment on column public.profiles.name is
  'Nome de exibição. Editável pelo próprio usuário.';
comment on column public.profiles.email is
  'Espelho do e-mail do auth.users. Imutável pelo cliente.';

-- Índices
create index if not exists idx_profiles_email
  on public.profiles (email);
create index if not exists idx_profiles_email_lower
  on public.profiles (lower(email));
create index if not exists idx_profiles_created_at
  on public.profiles (created_at desc);

-- RLS
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select
  using (auth.uid() = id);

drop policy if exists "profiles_update_own_name" on public.profiles;
create policy "profiles_update_own_name" on public.profiles
  for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "profiles_no_insert" on public.profiles;
create policy "profiles_no_insert" on public.profiles
  for insert with check (false);

drop policy if exists "profiles_no_delete" on public.profiles;
create policy "profiles_no_delete" on public.profiles
  for delete using (false);

-- Função: touch updated_at
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
before update on public.profiles
for each row execute function public.touch_updated_at();

-- Função: bloqueia alteração de id/email
create or replace function public.prevent_profile_immutable_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id then
    raise exception 'O id do perfil não pode ser alterado.';
  end if;
  if new.email is distinct from old.email then
    raise exception 'O e-mail não pode ser alterado diretamente.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_prevent_immutable on public.profiles;
create trigger trg_profiles_prevent_immutable
before update on public.profiles
for each row execute function public.prevent_profile_immutable_change();

-- Função: cria perfil no signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, name)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- Backfill
insert into public.profiles (id, email, name)
select
  u.id,
  coalesce(u.email, ''),
  coalesce(u.raw_user_meta_data ->> 'name', '')
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id)
on conflict (id) do nothing;


-- ═══════════════════════════════════════════════════════════════════════
--  02. albums — catálogo
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.albums (
  id          text primary key,
  title       text not null,
  artist      text,
  year        int,
  type        text not null default 'album'
              check (type in ('album', 'ep', 'single')),
  cover_initials text,
  cover_image text,
  description text default '',
  published   boolean not null default false,
  order_index int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.albums is 'Álbuns, EPs e singles.';

create index if not exists idx_albums_published
  on public.albums (published) where published = true;
create index if not exists idx_albums_published_order
  on public.albums (published, order_index);

alter table public.albums enable row level security;

drop policy if exists "albums_select_published" on public.albums;
create policy "albums_select_published" on public.albums
  for select using (published = true);

drop policy if exists "albums_no_write" on public.albums;
create policy "albums_no_write" on public.albums
  for all using (false) with check (false);

drop trigger if exists trg_albums_updated_at on public.albums;
create trigger trg_albums_updated_at
before update on public.albums
for each row execute function public.touch_updated_at();


-- ═══════════════════════════════════════════════════════════════════════
--  03. tracks — faixas do catálogo
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.tracks (
  id           bigserial primary key,
  album_id     text not null references public.albums(id) on delete cascade,
  track_index  int  not null check (track_index >= 0),
  title        text not null,
  duration     text,
  -- Áudio: paths no Supabase Storage
  --   full_path    → bucket privado  'audio-premium'  (URL assinada via /api/stream)
  --   preview_path → bucket público  'audio-preview'  (URL direta no /api/stream)
  full_path    text,
  preview_path text,
  preview_start int default 0 check (preview_start >= 0),
  preview_duration int default 30 check (preview_duration between 5 and 120),
  price_cents  int  not null check (price_cents > 0 and price_cents <= 1000000),
  for_sale     boolean not null default true,
  lyrics       jsonb default '[]'::jsonb,
  published    boolean not null default false,
  play_count   int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (album_id, track_index)
);

comment on table public.tracks is 'Faixas do catálogo. Preço em centavos.';
comment on column public.tracks.price_cents is 'Preço em centavos (R$ 4,90 = 490).';
comment on column public.tracks.full_path is
  'Nome do arquivo no bucket privado audio-premium. URL assinada gerada em /api/stream.';
comment on column public.tracks.preview_path is
  'Nome do arquivo no bucket público audio-preview. URL direta.';
comment on column public.tracks.play_count is
  'Número de reproduções completas (premium ou aluguel ativo). Não conta previews.';

create index if not exists idx_tracks_album
  on public.tracks (album_id, track_index);
create index if not exists idx_tracks_published
  on public.tracks (published) where published = true;

alter table public.tracks enable row level security;

drop policy if exists "tracks_select_published" on public.tracks;
create policy "tracks_select_published" on public.tracks
  for select using (published = true);

drop policy if exists "tracks_no_write" on public.tracks;
create policy "tracks_no_write" on public.tracks
  for all using (false) with check (false);

drop trigger if exists trg_tracks_updated_at on public.tracks;
create trigger trg_tracks_updated_at
before update on public.tracks
for each row execute function public.touch_updated_at();


-- ═══════════════════════════════════════════════════════════════════════
--  04. subscriptions — fonte de verdade do plano
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.subscriptions (
  id                  bigserial primary key,
  user_id             uuid not null references auth.users(id) on delete cascade,
  plan                text not null check (plan in ('premium', 'anual')),
  status              text not null check (status in ('pending', 'authorized', 'paused', 'canceled', 'trialing')),
  provider            text not null default 'mercadopago',
  provider_sub_id     text not null,
  external_reference  text,
  current_period_end  timestamptz,
  started_at          timestamptz,
  canceled_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (provider, provider_sub_id)
);

comment on table public.subscriptions is
  'Estado atual da assinatura. Fonte de verdade do plano.';

create index if not exists idx_subscriptions_user
  on public.subscriptions (user_id);
create index if not exists idx_subscriptions_status
  on public.subscriptions (status);
create index if not exists idx_subscriptions_user_status
  on public.subscriptions (user_id, status);

alter table public.subscriptions enable row level security;

drop policy if exists "subscriptions_select_own" on public.subscriptions;
create policy "subscriptions_select_own" on public.subscriptions
  for select using (auth.uid() = user_id);

drop policy if exists "subscriptions_no_write" on public.subscriptions;
create policy "subscriptions_no_write" on public.subscriptions
  for all using (false) with check (false);

drop trigger if exists trg_subscriptions_updated_at on public.subscriptions;
create trigger trg_subscriptions_updated_at
before update on public.subscriptions
for each row execute function public.touch_updated_at();


-- ═══════════════════════════════════════════════════════════════════════
--  05. payments_attempts — idempotência de checkout
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.payments_attempts (
  id                  bigserial primary key,
  user_id             uuid not null references auth.users(id) on delete cascade,
  kind                text not null default 'subscription'
                      check (kind in ('subscription', 'rental')),
  status              text not null default 'creating'
                      check (status in ('creating', 'pending', 'failed', 'completed', 'expired')),
  plan                text check (plan in ('premium', 'anual')),
  track_id            bigint references public.tracks(id) on delete set null,
  album_id            text,
  track_index         int,
  amount              numeric(10,2) not null check (amount > 0),
  currency            text not null default 'BRL',
  provider            text not null default 'mercadopago',
  preapproval_id      text,
  preference_id       text,
  checkout_url        text,
  external_reference  text not null unique,
  failure_reason      text,
  ip                  inet,
  user_agent          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.payments_attempts is
  'Tentativas de checkout. Base da idempotência de criação.';

create index if not exists idx_attempts_user_kind_status
  on public.payments_attempts (user_id, kind, status);
create index if not exists idx_attempts_preapproval
  on public.payments_attempts (preapproval_id);
create index if not exists idx_attempts_preference
  on public.payments_attempts (preference_id);
create index if not exists idx_attempts_created
  on public.payments_attempts (created_at desc);

alter table public.payments_attempts enable row level security;

drop policy if exists "attempts_no_access" on public.payments_attempts;
create policy "attempts_no_access" on public.payments_attempts
  for all using (false) with check (false);

drop trigger if exists trg_attempts_updated_at on public.payments_attempts;
create trigger trg_attempts_updated_at
before update on public.payments_attempts
for each row execute function public.touch_updated_at();


-- ═══════════════════════════════════════════════════════════════════════
--  06. payments_events — idempotência de webhooks
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.payments_events (
  id              bigserial primary key,
  provider        text not null default 'mercadopago',
  provider_event  text not null,
  event_type      text not null,
  external_id     text,
  payload         jsonb not null,
  processed_at    timestamptz,
  failure_reason  text,
  created_at      timestamptz not null default now(),
  unique (provider, provider_event)
);

comment on table public.payments_events is
  'Log de webhooks. Chave (provider, provider_event) garante idempotência.';

create index if not exists idx_events_external
  on public.payments_events (external_id);
create index if not exists idx_events_created
  on public.payments_events (created_at desc);
create index if not exists idx_events_unprocessed
  on public.payments_events (created_at)
  where processed_at is null;

alter table public.payments_events enable row level security;

drop policy if exists "events_no_access" on public.payments_events;
create policy "events_no_access" on public.payments_events
  for all using (false) with check (false);


-- ═══════════════════════════════════════════════════════════════════════
--  07. rentals — acesso temporário (48h)
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.rentals (
  id                  bigserial primary key,
  user_id             uuid not null references auth.users(id) on delete cascade,
  track_id            bigint not null references public.tracks(id) on delete cascade,
  payment_id          text not null,
  external_reference  text,
  amount_cents        int not null check (amount_cents > 0),
  status              text not null default 'active'
                      check (status in ('active', 'expired', 'refunded')),
  started_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  created_at          timestamptz not null default now(),
  unique (user_id, track_id, payment_id)
);

comment on table public.rentals is
  'Direito de acesso temporário a uma faixa. Unique por (user, track, payment).';

create index if not exists idx_rentals_user_track
  on public.rentals (user_id, track_id);
create index if not exists idx_rentals_expires
  on public.rentals (expires_at) where status = 'active';
create index if not exists idx_rentals_payment
  on public.rentals (payment_id);

alter table public.rentals enable row level security;

drop policy if exists "rentals_select_own" on public.rentals;
create policy "rentals_select_own" on public.rentals
  for select using (auth.uid() = user_id);

drop policy if exists "rentals_no_write" on public.rentals;
create policy "rentals_no_write" on public.rentals
  for all using (false) with check (false);


-- ═══════════════════════════════════════════════════════════════════════
--  08. site_content — conteúdo do site (JSON)
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.site_content (
  key         text primary key,
  data        jsonb not null default '{}'::jsonb,
  version     int not null default 0,
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now()
);

comment on table public.site_content is
  'Conteúdo editável do site (branding, hero, discografia, planos, etc).';

alter table public.site_content enable row level security;

drop policy if exists "site_content_public_read" on public.site_content;
create policy "site_content_public_read" on public.site_content
  for select using (true);

drop policy if exists "site_content_no_write" on public.site_content;
create policy "site_content_no_write" on public.site_content
  for all using (false) with check (false);

insert into public.site_content (key, data)
values ('default', '{}'::jsonb)
on conflict (key) do nothing;


-- ═══════════════════════════════════════════════════════════════════════
--  09. site_content_history — histórico para rollback
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.site_content_history (
  id          bigserial primary key,
  key         text not null,
  data        jsonb not null,
  version     int not null,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

comment on table public.site_content_history is
  'Versões anteriores de site_content. Permite rollback.';

create index if not exists idx_content_history_key
  on public.site_content_history (key, created_at desc);

alter table public.site_content_history enable row level security;

drop policy if exists "content_history_no_access" on public.site_content_history;
create policy "content_history_no_access" on public.site_content_history
  for all using (false) with check (false);


-- ═══════════════════════════════════════════════════════════════════════
--  10. admin_audit — trilha de auditoria do painel admin
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.admin_audit (
  id          bigserial primary key,
  actor       text,
  action      text not null,
  target      text,
  metadata    jsonb,
  ip          inet,
  user_agent  text,
  created_at  timestamptz not null default now()
);

comment on table public.admin_audit is
  'Trilha de auditoria de ações do painel admin.';

create index if not exists idx_admin_audit_created
  on public.admin_audit (created_at desc);
create index if not exists idx_admin_audit_action
  on public.admin_audit (action);

alter table public.admin_audit enable row level security;

drop policy if exists "admin_audit_no_access" on public.admin_audit;
create policy "admin_audit_no_access" on public.admin_audit
  for all using (false) with check (false);


-- ═══════════════════════════════════════════════════════════════════════
--  11. auth_audit_log — auditoria de autenticação
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.auth_audit_log (
  id          bigserial primary key,
  event       text not null,
  email_hash  text,
  user_id     uuid,
  ip          inet,
  user_agent  text,
  success     boolean not null,
  reason      text,
  created_at  timestamptz not null default now()
);

comment on table public.auth_audit_log is
  'Auditoria de login/signup/logout. E-mail hasheado.';

create index if not exists idx_auth_audit_created
  on public.auth_audit_log (created_at desc);
create index if not exists idx_auth_audit_email_hash
  on public.auth_audit_log (email_hash);
create index if not exists idx_auth_audit_ip
  on public.auth_audit_log (ip);
create index if not exists idx_auth_audit_event
  on public.auth_audit_log (event, created_at desc);

alter table public.auth_audit_log enable row level security;

drop policy if exists "auth_audit_no_access" on public.auth_audit_log;
create policy "auth_audit_no_access" on public.auth_audit_log
  for all using (false) with check (false);


-- ═══════════════════════════════════════════════════════════════════════
--  12. view effective_plan — plano derivado de subscriptions
-- ═══════════════════════════════════════════════════════════════════════
create or replace view public.effective_plan as
select
  p.id as user_id,
  case
    when s.status in ('authorized', 'trialing')
         and (s.current_period_end is null or s.current_period_end > now())
      then s.plan
    else 'free'
  end as plan
from public.profiles p
left join lateral (
  select plan, status, current_period_end
  from public.subscriptions
  where user_id = p.id
  order by
    case status
      when 'authorized' then 1
      when 'trialing' then 2
      when 'pending' then 3
      when 'paused' then 4
      when 'canceled' then 5
      else 6
    end,
    created_at desc
  limit 1
) s on true;

comment on view public.effective_plan is
  'Plano efetivo do usuário: deriva de subscriptions. Nunca escreve direto.';

revoke all on public.effective_plan from anon, authenticated;
grant select on public.effective_plan to service_role;


-- ═══════════════════════════════════════════════════════════════════════
--  13. grants explícitos
-- ═══════════════════════════════════════════════════════════════════════
revoke all on public.profiles from anon, authenticated;
grant select, update on public.profiles to authenticated;
grant all on public.profiles to service_role;

revoke all on public.albums from anon, authenticated;
grant select on public.albums to anon, authenticated;
grant all on public.albums to service_role;

revoke all on public.tracks from anon, authenticated;
grant select on public.tracks to anon, authenticated;
grant all on public.tracks to service_role;

revoke all on public.subscriptions from anon, authenticated;
grant select on public.subscriptions to authenticated;
grant all on public.subscriptions to service_role;

revoke all on public.rentals from anon, authenticated;
grant select on public.rentals to authenticated;
grant all on public.rentals to service_role;

revoke all on public.site_content from anon, authenticated;
grant select on public.site_content to anon, authenticated;
grant all on public.site_content to service_role;

revoke all on public.payments_attempts from anon, authenticated;
grant all on public.payments_attempts to service_role;

revoke all on public.payments_events from anon, authenticated;
grant all on public.payments_events to service_role;

revoke all on public.site_content_history from anon, authenticated;
grant all on public.site_content_history to service_role;

revoke all on public.admin_audit from anon, authenticated;
grant all on public.admin_audit to service_role;

revoke all on public.auth_audit_log from anon, authenticated;
grant all on public.auth_audit_log to service_role;


-- ═══════════════════════════════════════════════════════════════════════
--  14. reload PostgREST
-- ═══════════════════════════════════════════════════════════════════════
notify pgrst, 'reload schema';


-- ═══════════════════════════════════════════════════════════════════════
--  15. POLICIES para service_role (tabelas) — ESSENCIAL!
-- ---------------------------------------------------------------
--  O service_role NÃO bypassa RLS automaticamente no Supabase.
--  Sem estas policies, o painel admin retorna 502.
-- ═══════════════════════════════════════════════════════════════════════

drop policy if exists "profiles_service_all" on public.profiles;
create policy "profiles_service_all" on public.profiles
  for all to service_role using (true) with check (true);

drop policy if exists "albums_service_all" on public.albums;
create policy "albums_service_all" on public.albums
  for all to service_role using (true) with check (true);

drop policy if exists "tracks_service_all" on public.tracks;
create policy "tracks_service_all" on public.tracks
  for all to service_role using (true) with check (true);

drop policy if exists "subscriptions_service_all" on public.subscriptions;
create policy "subscriptions_service_all" on public.subscriptions
  for all to service_role using (true) with check (true);

drop policy if exists "rentals_service_all" on public.rentals;
create policy "rentals_service_all" on public.rentals
  for all to service_role using (true) with check (true);

drop policy if exists "site_content_service_all" on public.site_content;
create policy "site_content_service_all" on public.site_content
  for all to service_role using (true) with check (true);

drop policy if exists "site_content_history_service_all" on public.site_content_history;
create policy "site_content_history_service_all" on public.site_content_history
  for all to service_role using (true) with check (true);

drop policy if exists "payments_attempts_service_all" on public.payments_attempts;
create policy "payments_attempts_service_all" on public.payments_attempts
  for all to service_role using (true) with check (true);

drop policy if exists "payments_events_service_all" on public.payments_events;
create policy "payments_events_service_all" on public.payments_events
  for all to service_role using (true) with check (true);

drop policy if exists "admin_audit_service_all" on public.admin_audit;
create policy "admin_audit_service_all" on public.admin_audit
  for all to service_role using (true) with check (true);

drop policy if exists "auth_audit_log_service_all" on public.auth_audit_log;
create policy "auth_audit_log_service_all" on public.auth_audit_log
  for all to service_role using (true) with check (true);


-- ═══════════════════════════════════════════════════════════════════════
--  16. MIGRAÇÃO — de full_audio/preview_audio para full_path/preview_path
-- ---------------------------------------------------------------
--  Bancos criados com versões antigas do schema podem ter as colunas
--  antigas. Este bloco:
--    1) Garante que full_path/preview_path existam
--    2) Migra dados das colunas antigas (se existirem)
--    3) Remove as colunas antigas (se existirem)
--
--  Idempotente: rodar várias vezes não causa erro.
-- ═══════════════════════════════════════════════════════════════════════

-- 1) Garante que as colunas novas existem
alter table public.tracks
  add column if not exists full_path text,
  add column if not exists preview_path text;

-- 2) Migra dados das colunas antigas (só se existirem)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'tracks'
      and column_name = 'full_audio'
  ) then
    execute $sql$
      update public.tracks
      set full_path = regexp_replace(full_audio, '^.*/', '')
      where full_path is null
        and full_audio is not null
        and full_audio <> ''
    $sql$;

    execute $sql$
      update public.tracks
      set preview_path = regexp_replace(preview_audio, '^.*/', '')
      where preview_path is null
        and preview_audio is not null
        and preview_audio <> ''
    $sql$;
  end if;
end $$;

-- 3) Remove as colunas antigas (só se existirem)
alter table public.tracks
  drop column if exists full_audio,
  drop column if exists preview_audio;


-- ═══════════════════════════════════════════════════════════════════════
--  17. STORAGE — policies (buckets devem ser criados pelo Dashboard)
-- ---------------------------------------------------------------
--  ⚠️  IMPORTANTE
--
--  Os 3 buckets NÃO são criados via SQL porque a role do SQL Editor
--  não tem permissão de owner sobre `storage.buckets` (essa tabela
--  pertence à role interna `supabase_storage_admin`).
--
--  Tentar rodar `insert into storage.buckets (...)` resulta em:
--     ERROR: 42501: must be owner of table buckets
--
--  Crie os buckets manualmente pelo Dashboard do Supabase:
--     Storage → New bucket
--
--  Parâmetros exatos:
--
--  ┌────────────────┬──────────┬────────────┬─────────────────────────────────────────────────────┐
--  │ Nome           │ Público? │ Limite     │ MIME types permitidos                               │
--  ├────────────────┼──────────┼────────────┼─────────────────────────────────────────────────────┤
--  │ site-assets    │ ✅ Sim   │ 10 MB      │ image/jpeg, image/png, image/webp, image/gif        │
--  │ audio-preview  │ ✅ Sim   │ 10 MB      │ audio/mpeg, audio/mp4, audio/wav, audio/ogg         │
--  │ audio-premium  │ ❌ Não   │ 50 MB      │ audio/mpeg, audio/mp4, audio/wav, audio/ogg         │
--  └────────────────┴──────────┴────────────┴─────────────────────────────────────────────────────┘
--
--  ⚠️  ATENÇÃO: `audio-premium` deve ser PRIVADO. Se você marcar como
--  público, o sistema de signed URLs perde a proteção — qualquer pessoa
--  com a URL direta consegue baixar o áudio completo.
--
--  Depois de criar os buckets, as policies abaixo configuram o acesso.
--  Elas PODEM ser criadas via SQL Editor (a role tem permissão em
--  `storage.objects`).
-- ═══════════════════════════════════════════════════════════════════════

-- 17.1. Policies de RLS para storage.objects

-- site-assets: leitura pública (imagens)
drop policy if exists "site_assets_public_read" on storage.objects;
create policy "site_assets_public_read"
  on storage.objects for select
  using (bucket_id = 'site-assets');

-- audio-preview: leitura pública (previews)
drop policy if exists "audio_preview_public_read" on storage.objects;
create policy "audio_preview_public_read"
  on storage.objects for select
  using (bucket_id = 'audio-preview');

-- audio-premium: NENHUMA policy de SELECT pública.
--   O bucket é privado. Acesso via signed URLs geradas pelo /api/stream.

-- service_role: acesso total a todos os buckets
--   Necessário para uploads via /api/admin?action=upload
drop policy if exists "storage_service_role_all" on storage.objects;
create policy "storage_service_role_all"
  on storage.objects for all
  to service_role
  using (true)
  with check (true);


-- ═══════════════════════════════════════════════════════════════════════
--  18. reload PostgREST (final)
-- ═══════════════════════════════════════════════════════════════════════
notify pgrst, 'reload schema';


-- ═══════════════════════════════════════════════════════════════════════
--  19. STATS — contador de plays por faixa
-- ---------------------------------------------------------------
--  play_count = número de vezes que a faixa foi tocada COMPLETA
--  (usuário premium ou aluguel ativo). NÃO conta previews.
--
--  Incrementado via RPC increment_play_count() pelo /api/stream
--  quando uma URL assinada é gerada (fire-and-forget, sem bloquear).
--
--  Idempotente: pode ser rodado várias vezes sem erro.
-- ═══════════════════════════════════════════════════════════════════════

-- 19.1. Coluna play_count (garante existência em bancos antigos)
alter table public.tracks
  add column if not exists play_count int not null default 0;

comment on column public.tracks.play_count is
  'Número de reproduções completas (premium ou aluguel ativo). Não conta previews.';

-- 19.2. Índice para "top mais tocadas"
create index if not exists idx_tracks_play_count
  on public.tracks (play_count desc)
  where play_count > 0;

-- 19.3. Função RPC — incrementar (atômico)
create or replace function public.increment_play_count(p_track_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.tracks
  set play_count = play_count + 1
  where id = p_track_id
    and published = true;
end;
$$;

revoke all on function public.increment_play_count(bigint) from anon, authenticated;
grant execute on function public.increment_play_count(bigint) to service_role;

-- 19.4. Reload PostgREST (para expor a RPC)
notify pgrst, 'reload schema';
