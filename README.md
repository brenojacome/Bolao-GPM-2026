# Bolão Copa 2026

App web para bolão da Copa do Mundo FIFA 2026 (EUA · México · Canadá).

## Stack

- **Frontend:** HTML + CSS + JS puro — GitHub Pages (`/docs`)
- **Banco:** Supabase (PostgreSQL + RLS + Realtime)
- **Auth:** Supabase Auth (e-mail + senha)
- **Resultados:** API-Football (api-sports.io) via GitHub Actions
- **Automação:** GitHub Actions (cron horário + `workflow_dispatch`)

## Setup

### 1. Supabase

1. Crie um projeto no [Supabase](https://supabase.com) (região: São Paulo)
2. Execute o SQL em `supabase/schema.sql`
3. Configure as políticas RLS conforme `supabase/rls.sql`
4. Popule as tabelas com `supabase/seed.sql`

### 2. GitHub Secrets

No repositório → Settings → Secrets → Actions, adicione:

| Secret | Descrição |
|---|---|
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave de serviço (nunca no frontend) |
| `APIFOOTBALL_KEY` | Chave da API-Football (api-sports.io) |

### 3. Frontend

Edite `docs/js/supabase.js` com a URL e a `anon key` do seu projeto Supabase.

### 4. GitHub Pages

Settings → Pages → Source: `Deploy from a branch` → Branch: `main` → Folder: `/docs`

## Estrutura

```
docs/          # SPA (GitHub Pages)
scripts/       # Script de sync (GitHub Actions)
data/          # Fixture dos 104 jogos
.github/       # Workflow de sincronização
```

## Regras de pontuação

| Acerto | Pontos |
|---|---|
| Placar exato (90 min) | 3 pts |
| Vencedor/empate certo | 1 pt |
| 1º do grupo (exato) | 2 pts |
| 2º do grupo (exato) | 1 pt |
| Campeã (posição exata) | 10 pts |
| Vice (posição exata) | 6 pts |
| 3º ou 4º (posição exata) | 4 pts cada |
| Top 4, posição errada | 2 pts cada |
