# 🤖 Editbot — Diffusion de Scores en Direct

Bot Telegram qui diffuse automatiquement les scores de football en direct sur les Pages Facebook de ses utilisateurs.

## Fonctionnement

```
TheSportsDB API (cron toutes les minutes)
     │
     ▼
fetch-matches  → indexe les matchs dans matchs_index
     │  (dès qu'un score change)
     ▼
facebook-post  → publie automatiquement sur les Pages Facebook concernées
```

## Fonctionnalités

- **Scores en direct** : Telegram affiche les matchs live, d'aujourd'hui et le programme à venir
- **Diffusion Facebook** : publication automatique des scores sur les Pages Facebook connectées
- **Mini App Telegram** : interface pour choisir sa compétition, connecter sa Page Facebook, gérer son wallet et ses coupons
- **IA conversationnelle** : réponses naturelles via Groq (LLaMA 3.3 70B)

## Stack

- **Runtime** : Supabase Edge Functions (Deno)
- **Base de données** : Supabase PostgreSQL
- **IA** : Groq API (LLaMA 3.3 70B)
- **Données sportives** : TheSportsDB
- **Bot** : Telegram Bot API
- **Mini App** : React + Vite (déployé sur Vercel)

## Tables Supabase

| Table | Rôle |
|---|---|
| `user_profiles` | Profils utilisateurs Telegram |
| `bot_sessions` | Sessions et historique de conversation |
| `matchs_index` | Index des matchs (scores en direct) |
| `broadcast_selections` | Compétitions sélectionnées pour diffusion Facebook |
| `facebook_connections` | Pages Facebook connectées |
| `facebook_posts_log` | Historique des publications Facebook |
| `facebook_oauth_states` | États temporaires OAuth Facebook |
| `quota_journalier` | Quota d'appels API TheSportsDB par jour |
| `wallets` + `wallet_transactions` | Système de portefeuille |
| `coupons` | Codes coupons bookmakers |

## Edge Functions

| Fonction | Déclencheur | Rôle |
|---|---|---|
| `telegram-webhook` | Webhook Telegram | Répond aux messages des utilisateurs |
| `fetch-matches` | CRON (toutes les minutes) | Récupère les scores et déclenche la diffusion |
| `facebook-post` | Appelé par fetch-matches | Publie les scores sur les Pages Facebook |
| `facebook-oauth` | Lien OAuth | Connecte une Page Facebook |
| `mini-app-api` | Mini App | API REST de la Mini App Telegram |
| `morning-wakeup` | CRON quotidien | Réveil quotidien du bot |
| `setup-webhook` | Manuel | Configure le webhook Telegram |

## Secrets requis (Supabase)

- `TELEGRAM_BOT_TOKEN`
- `GROQ_API_KEY`
- `THESPORTSDB_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CRON_SECRET`
- `FACEBOOK_APP_ID`
- `FACEBOOK_APP_SECRET`
- `WEB_APP_URL` ← URL de la Mini App Vercel

## Déploiement

```bash
supabase functions deploy telegram-webhook
supabase functions deploy fetch-matches
supabase functions deploy facebook-post
supabase functions deploy facebook-oauth
supabase functions deploy mini-app-api
supabase functions deploy morning-wakeup
supabase functions deploy setup-webhook
```
