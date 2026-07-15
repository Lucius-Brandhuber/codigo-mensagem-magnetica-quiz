-- Config server-side da rcm-api (chave admin TOFU, etc.)
-- RLS ligado SEM policy: só a Edge Function (service_role) lê/grava — igual a eventos/vendas/capi_log.
-- Aplicada em 2026-07-14 no projeto Supabase cwcryqleyfzeyzjzvdme via MCP.
create table if not exists public.admin_settings (
  k text primary key,
  v text not null,
  criado_em timestamptz not null default now()
);
alter table public.admin_settings enable row level security;
revoke all on public.admin_settings from anon, authenticated;
