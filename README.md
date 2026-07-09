# 🤖 Editbot — Moteur de Pronostics Sportifs

Bot Telegram de pronostics sportifs automatisé basé sur l'analyse IA des données historiques.

## Architecture

Source API : agrégateur de cotes fiable (type OddsPapi / The Odds API) qui alimente les
tables de données brutes. **Interdiction formelle d'interroger l'API en temps réel lors des
requêtes utilisateurs** — toutes les données sont récupérées via des cron jobs à intervalles
réguliers (Batch).

```
Source API (OddsPapi / The Odds API)
     │  (cron — jamais en direct)
     ▼
historique_performances   ← résultats passés, stats (possession, tirs, etc.)
     │
     ▼
analyse_confrontation     ← moteur de calcul : croise historique_performances
     │                       + cotes brutes → probabilités & analyses
     ▼
pronostics_finaux         ← table de consultation, résumé "prêt à servir"
     │
     ▼
telegram-webhook (Edge Function)
     │
     ├── SELECT simple sur pronostics_finaux (aucun calcul en direct)
     └── Réponse instantanée à l'utilisateur Telegram
```

### Objectifs de performance

- **Zéro latence** : le bot répond en quelques millisecondes (SELECT simple sur
  `pronostics_finaux`, jamais de calcul en direct).
- **Gestion des quotas** : mise à jour périodique (Batch) via cron → on reste largement
  dans les limites des plans gratuits des API.
- **Indépendance** : en cas de coupure de l'API externe, le bot reste fonctionnel car il
  s'appuie sur les données déjà calculées et stockées.

## Stack

- **Runtime** : Supabase Edge Functions (Deno)
- **Base de données** : Supabase PostgreSQL
- **IA** : Groq API (llama3-70b-8192)
- **Données** : SofaScore via RapidAPI
- **Bot** : Telegram Bot API

## Tables Supabase

| Table | Rôle |
|---|---|
| `historique_performances` | Résultats passés, stats (possession, tirs, etc.) |
| `marches_bookmakers` | Cotes brutes par bookmaker |
| `analyse_confrontation` | Moteur de calcul : croise historique + cotes → probabilités/analyses |
| `pronostics_finaux` | **Table de consultation** — seule table lue par le bot, résumé prêt à servir |
| `whitelist_matchs` | Matchs prioritaires pour le refresh sélectif des cotes |
| `matchs_historique` *(legacy)* | Ancienne table de matchs, conservée pour compatibilité |
| `pronostics_pre_calcules` *(legacy)* | Ancien cache de pronostics, conservé en écriture parallèle |

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
