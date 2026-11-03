-- Caixa — esquema do banco.
-- Rode no Supabase: SQL Editor → New query → cole tudo → Run.
-- Pode rodar de novo sem perder dados: só cria o que falta.
-- Cada pessoa só enxerga e altera as próprias linhas (Row Level Security).

-- Gastos (das faturas e lançados à mão)
create table if not exists public.transactions (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  uid         text not null,            -- impressão digital da linha (evita duplicar ao reenviar a fatura)
  date        date not null,
  title       text not null,
  amount      numeric(12,2) not null,
  category    text,                     -- escolhida à mão (vazio = usa as regras)
  created_at  timestamptz not null default now(),
  unique (user_id, uid)
);
alter table public.transactions add column if not exists source text not null default 'nubank';
alter table public.transactions add column if not exists manual boolean not null default false;

-- Regras de categoria
create table if not exists public.rules (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  keyword     text not null,
  category    text not null,
  created_at  timestamptz not null default now()
);

-- Ajustes (cartões, tetos, fixos, entradas fixas)
create table if not exists public.settings (
  user_id     uuid primary key default auth.uid() references auth.users on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- Entradas recebidas (salário, vintena, extras)
create table if not exists public.incomes (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  date        date not null,
  name        text not null,
  amount      numeric(12,2) not null,
  rule_key    text,                     -- qual entrada fixa ela confirma (vazio = avulsa)
  created_at  timestamptz not null default now()
);

-- Reservas: reserva de emergência, caixinhas e investimentos
create table if not exists public.accounts (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  name        text not null,
  kind        text not null check (kind in ('reserva', 'caixinha', 'investimento')),
  balance     numeric(12,2) not null default 0,
  goal        numeric(12,2),
  note        text,
  updated_at  timestamptz not null default now()
);

-- Aportes (para saber quanto foi guardado no mês)
create table if not exists public.contributions (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  account_id  bigint not null references public.accounts on delete cascade,
  date        date not null,
  amount      numeric(12,2) not null,
  created_at  timestamptz not null default now()
);

create index if not exists transactions_user_date on public.transactions (user_id, date);
create index if not exists rules_user on public.rules (user_id);
create index if not exists incomes_user_date on public.incomes (user_id, date);
create index if not exists contributions_user_date on public.contributions (user_id, date);

do $$
declare t text;
begin
  foreach t in array array['transactions', 'rules', 'settings', 'incomes', 'accounts', 'contributions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "dono" on public.%I', t);
    execute format('create policy "dono" on public.%I for all using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);
    -- tempo real: mudanças feitas no PC aparecem no celular sem recarregar
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
