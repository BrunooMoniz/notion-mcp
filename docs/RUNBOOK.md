# Runbook — operação, backup, restore, recuperação

Operação do notion-mcp na VPS única (PM2). Para subir do zero, ver README ("Run with Docker") ou o setup manual.

## Processos (PM2)
`notion-mcp` (servidor MCP, :3456), `brain-indexer` (cron horário), `brain-classifier` (classifier :30, revisitar 07:00, granola→reunião */15, **briefing 07:00**), `brain-reindex-nightly` (reindex full 04:00). `pm2 save` mantém após reboot.

## Saúde / observabilidade
- `GET /status` (Bearer) — última sync, idade e erro por fonte; `stale_or_failing` lista o que está parado.
- `npm run doctor` — valida Postgres/extensões/tabelas/Voyage/tokens Notion/iCal. Rode após qualquer mudança de env.
- Indexer loga `[ALERT]` + escreve na página Notion "Saúde do Cérebro" quando uma fonte fica parada.

## Backup
- Cron `0 3 * * *` → `/root/backup-brain.sh`: `pg_dump -Fc` → `/root/backups/brain-YYYY-MM-DD.dump`, **retenção 7 dias**, log em `/root/backups/backup.log`.
- Dumps ficam em `/root/` (só root lê).
- ⚠️ **SPOF:** os backups vivem na MESMA VPS. Se a VPS morrer, os dumps vão junto. **Ação recomendada (ainda não feita):** cópia offsite (rclone p/ S3/Backblaze/Drive, ou `scp` p/ outra máquina) num cron diário. Precisa de um destino+credencial — quando o Bruno fornecer, é ~10 min de setup.

## Restore (procedimento verificado — 2026-06-04, restaurou 5495 chunks OK)
O `pg_restore` roda como usuário `postgres`, que NÃO lê `/root/` — então copie o dump pra um local legível primeiro:
```bash
cp /root/backups/brain-<DATA>.dump /tmp/rt.dump && chmod 644 /tmp/rt.dump
# DB de teste (não toca prod):
sudo -u postgres createdb brain_restore_test
sudo -u postgres psql -d brain_restore_test -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS unaccent; CREATE EXTENSION IF NOT EXISTS pg_trgm;"
sudo -u postgres pg_restore --no-owner -d brain_restore_test /tmp/rt.dump
sudo -u postgres psql -tA -d brain_restore_test -c "SELECT count(*) FROM brain_chunks;"   # confere
sudo -u postgres dropdb brain_restore_test && rm -f /tmp/rt.dump
```
**Restore de verdade (DR)** sobre o banco `brain`: `pm2 stop brain-indexer brain-classifier brain-reindex-nightly` → restaurar num `brain` novo (createdb + extensões + pg_restore) → apontar `POSTGRES_URL` → `pm2 start`. Faça um restore-test assim ~1x/mês.

## Rotação de segredos
- **Acesso SSH:** chave `claude-code-notion-vps` em `~/.ssh/authorized_keys` (auth primária). Trocar a **senha root** (foi exposta em chat) — `passwd`. fail2ban ativo (cuidado com tentativas de senha em rajada).
- **OAuth (claude.ai):** TTL de acesso curto + refresh-token; revogar cliente comprometido via `POST /admin/revoke` (Bearer) `{client_id}` ou `{token}`.
- **Notion PATs:** expiram em 1 ano — anotar renovação no calendar. iCal URLs e tokens (Voyage/Anthropic/Granola): rotacionar resetando na origem + atualizar `.env` → `pm2 restart --update-env` → `npm run doctor`.
- Arquivos secretos em `data/` (oauth/google) com `chmod 600`; `.env`/`data/` gitignored.

## Recuperação completa (VPS nova)
1. Provisionar box (Node 20+, Postgres 16+pgvector) **ou** `docker compose up` (ver README).
2. Restaurar o último dump no banco `brain` (extensões + `pg_restore`).
3. Criar `.env` com os segredos (PATs Notion, BEARER, OAUTH_PASSWORD_HASH, POSTGRES_URL, VOYAGE_API_KEY, GOOGLE_CAL_ICS, BRIEFING_PAGE_ID, etc.).
4. `npm ci && npm run build && npm run migrate && pm2 start ecosystem.config.cjs && pm2 save`.
5. `npm run doctor` verde + `GET /status` ok. Reapontar o endpoint/Tailscale Funnel.
