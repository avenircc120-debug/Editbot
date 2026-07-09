# 🤖 Editbot — Moteur de Pronostics Sportifs

Bot Telegram de pronostics sportifs automatisé basé sur l'analyse IA des données historiques.

## Architecture

```
Telegram User
     │
     ▼
telegram-webhook (Edge Function)
     │
     ├── Requête SQL sur pronostics_pre_calcules (cache)
     │
     └── Réponse formatée instantanée
     
fetch-matches (CRON quotidien)
     │
     └── SofaScore API → matchs_historique (Supabase)

analyse-matches (CRON quotidien)
     │
     ├── matchs_historique → Groq API (analyse)
     └── → pronostics_pre_calcules (cache 6h)
```

## Stack

- **Runtime** : Supabase Edge Functions (Deno)
- **Base de données** : Supabase PostgreSQL
- **IA** : Groq API (llama3-70b-8192)
- **Données** : SofaScore via RapidAPI
- **Bot** : Telegram Bot API

## Tables Supabase

| Table | Rôle |
|---|---|
| `matchs_historique` | Données brutes des matchs |
| `pronostics_pre_calcules` | Cache des pronostics IA |

## Edge Functions

| Fonction | Déclencheur | Rôle |
|---|---|---|
| `telegram-webhook` | Webhook Telegram | Répond aux utilisateurs |
| `fetch-matches` | CRON quotidien | Ingestion SofaScore |
| `analyse-matches` | CRON quotidien | Génère pronostics via Groq |
| `setup-webhook` | Manuel | Configure le webhook Telegram |

## Commandes Telegram

| Commande | Description |
|---|---|
| `/pronostics` | Top 5 pronostics du jour |
| `/ligue1` | Matchs Ligue 1 |
| `/pl` | Matchs Premier League |
| `/ldc` | Matchs Champions League |
| `/detail [id]` | Analyse complète |
| `/aide` | Aide |

## Secrets requis (Supabase Vault)

- `TELEGRAM_BOT_TOKEN`
- `GROQ_API_KEY`
- `RAPIDAPI_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## Déploiement

```bash
supabase functions deploy telegram-webhook
supabase functions deploy fetch-matches
supabase functions deploy analyse-matches
supabase functions deploy setup-webhook
```

## Configuration Webhook

Appeler une fois après déploiement :
```
GET https://<project>.supabase.co/functions/v1/setup-webhook?url=https://<project>.supabase.co/functions/v1/telegram-webhook
```

## Stratégie économie de quotas

- **Anti-doublon** : Vérification en base avant chaque appel SofaScore
- **Cache Groq** : Pronostic valide 6h, jamais régénéré si existant
- **Tokens optimisés** : Résumés statistiques envoyés à Groq (pas de raw data)
- **Limite** : 500 req SofaScore/mois, Groq gratuit jusqu'à 14,400 req/jour
