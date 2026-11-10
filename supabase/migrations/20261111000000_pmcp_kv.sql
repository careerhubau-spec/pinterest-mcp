-- Storage for the hosted Pinterest MCP: OAuth clients, pending sign-ins, auth codes,
-- hashed access/refresh tokens and encrypted Pinterest grants. Only the service role touches it.
create table if not exists public.pmcp_kv (
  ns         text        not null,
  key        text        not null,
  value      jsonb       not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (ns, key)
);
create index if not exists pmcp_kv_expires_idx on public.pmcp_kv (expires_at) where expires_at is not null;
alter table public.pmcp_kv enable row level security;
revoke all on public.pmcp_kv from anon, authenticated;
grant select, insert, update, delete on public.pmcp_kv to service_role;
comment on table public.pmcp_kv is 'Pinterest MCP OAuth state. RLS on, no policies: service role only.';
