# 🤖 Editbot — Diffusion de Scores en Direct

Bot Telegram qui diffuse automatiquement les scores de football en direct sur les Pages Facebook de ses utilisateurs.

---

## Flux principal

```
TheSportsDB API (CRON toutes les minutes)
     │
     ▼
fetch-matches ──── lit/écrit ──── matchs_index (Supabase)
     │                                  │
     │  (score changé ou fin de match)  │
     ▼                                  ▼
facebook-post ──── publie sur ──── Pages Facebook des utilisateurs
                                   (filtrées par broadcast_selections)
```

> Le bot répond aussi aux messages Telegram en temps réel via `telegram-webhook`.
> L'IA (Groq / LLaMA 3.3 70B) ne fait **jamais** de pronostics — elle guide uniquement vers les fonctionnalités du bot.

---

## Stack

| Couche | Technologie |
|---|---|
| **Runtime backend** | Supabase Edge Functions (Deno) |
| **Base de données** | Supabase PostgreSQL + Row Level Security |
| **IA conversationnelle** | Groq API — LLaMA 3.3 70B (`llama-3.3-70b-versatile`) |
| **Données sportives** | TheSportsDB API |
| **Bot** | Telegram Bot API (webhook) |
| **Mini App Telegram** | React 19 + Vite 7 (déployé sur Vercel) |
| **UI Mini App** | shadcn/ui (composants complets) |

---

## Edge Functions

| Fonction | Déclencheur | Rôle réel |
|---|---|---|
| `telegram-webhook` | Webhook Telegram | Reçoit les messages, appelle Groq, transforme les marqueurs `[[BUTTON:X]]` en boutons inline |
| `fetch-matches` | CRON (chaque minute) | Récupère les scores TheSportsDB, met à jour `matchs_index`, appelle `facebook-post` si score changé |
| `facebook-post` | Appelé par `fetch-matches` | Publie le score sur les Pages Facebook des utilisateurs abonnés à la compétition |
| `facebook-oauth` | Lien OAuth Facebook | Gère le flux OAuth v19 avec nonce CSRF (expiration 10 min), stocke le token de page |
| `mini-app-api` | Mini App Telegram | API REST — auth via `initData` Telegram, retourne token Bearer pour les appels suivants |
| `web-portal` | Lien web depuis Telegram | API REST — auth via `web_access_token` (colonne `user_profiles`), sert Wallet / Facebook / Coupons / Matchs pour accès hors Telegram |
| `morning-wakeup` | CRON quotidien | Envoie la liste des matchs du jour **pour la compétition de chaque utilisateur** (pas de message si aucun match) |
| `setup-webhook` | Manuel | Enregistre l'URL webhook auprès de l'API Telegram |

---

## Modules partagés (`_shared/`)

| Fichier | Contenu |
|---|---|
| `config.ts` | `THESPORTSDB`, `GROQ`, liste `LEAGUES` (17 compétitions), `SYSTEM_PROMPT` |
| `facebook.ts` | Helpers Graph API Facebook (publication, gestion tokens de page) |
| `groq.ts` | Client Groq — appel LLaMA 3.3 70B |
| `quota.ts` | Gestion du quota journalier TheSportsDB (`quota_journalier`) |
| `templates.ts` | Templates de messages Telegram (réveil matinal, scores) |
| `thesportsdb.ts` | Client TheSportsDB — fetch matchs live et programme |

---

## Schéma de base de données

### Tables principales

| Table | Rôle |
|---|---|
| `user_profiles` | Profils Telegram — contient `competition_suivie`, `competition_suivie_id`, `web_access_token` |
| `bot_sessions` | Sessions et historique de conversation Telegram |
| `matchs_index` | Index des matchs avec scores en direct (source de vérité pour les scores) |
| `matchs_bruts` | Données brutes TheSportsDB avant normalisation (migration 002) |
| `broadcast_selections` | Compétitions sélectionnées par utilisateur pour la diffusion Facebook |
| `quota_journalier` | Compteur d'appels API TheSportsDB par jour (migration 003) |
| `sources_hybrides` | Sources hybrides de données sportives (migration 004) |
| `facebook_connections` | Pages Facebook connectées (token, page_id, page_name) |
| `facebook_posts_log` | Historique des publications (nettoyage auto > 30 jours) |
| `facebook_oauth_states` | Nonces OAuth CSRF — usage unique, expiration 10 min |
| `wallets` + `wallet_transactions` | Portefeuille utilisateur |
| `coupons` | Codes coupons bookmakers |
| `pronostics_finaux` | Table présente en base — **non exposée via l'IA** (migration 006) |

### Fonctions SQL notables

| Fonction | Rôle |
|---|---|
| `purger_oauth_states_expires()` | Supprime les nonces OAuth expirés |
| `purger_facebook_posts_log()` | Purge les logs de publication > 30 jours |
| `supprimer_donnees_utilisateur(telegram_user_id)` | **RGPD** — suppression complète des données d'un utilisateur |

### État des migrations

| Fichier | Statut |
|---|---|
| `001_initial_schema.sql` | ✅ Schéma de base |
| `002_marches_bruts.sql` | ✅ Table `matchs_bruts` |
| `003_quota_journalier.sql` | ✅ Table `quota_journalier` |
| `004_sources_hybrides.sql` | ✅ Table `sources_hybrides` |
| `005_cleanup_predictions.sql` | ⚠️ Numéro 005 en doublon |
| `005_masap_schema.sql` | ⚠️ Numéro 005 en doublon — schéma MASAP |
| `006_facebook_and_web.sql` | ⚠️ Numéro 006 en doublon |
| `006_pronostics_finaux.sql` | ⚠️ Numéro 006 en doublon |
| `007_facebook_connections.sql` | ✅ Extensions `facebook_connections` |

> ⚠️ **Attention** : Les numéros de migration 005 et 006 sont en doublon. L'ordre d'application peut être non déterministe selon l'outil de migration.

---

## Authentification — deux surfaces

### Mini App Telegram
1. Telegram injecte `initData` dans la Mini App au lancement
2. La Mini App envoie `initData` à `POST /auth` sur `mini-app-api`
3. `mini-app-api` valide la signature Telegram, retourne un token Bearer
4. Tous les appels suivants utilisent `Authorization: Bearer <token>`

### Web Portal (accès hors Telegram)
1. Le bot génère un lien avec `web_access_token` (colonne `user_profiles`)
2. L'utilisateur ouvre le lien dans son navigateur
3. `web-portal` valide le token via `SELECT … WHERE web_access_token = ?`
4. Accès sans mot de passe — le token fait office de session

---

## Mini App Telegram (`mini-app/`)

- **Framework** : React 19 + Vite 7 (TypeScript strict)
- **UI** : shadcn/ui (accordéon, dialog, drawer, tabs, toast, etc.)
- **Build** : `npm run build` → `dist/` (déployé sur Vercel via `vercel.json`)
- **Routing** : SPA — Vercel rewrite `/* → /index.html`
- **Alias** : `@/` → `src/`

### Pages et onglets

| Route / Onglet | Fichier | Rôle |
|---|---|---|
| `/matches` | `pages/Matches.tsx` | Vue matchs |
| Onglet Matchs | `tabs/MatchsTab.tsx` | Scores live, aujourd'hui, programme |
| Onglet Facebook | `tabs/FacebookTab.tsx` | Connexion et gestion de la Page Facebook |
| Onglet Wallet | `tabs/WalletTab.tsx` | Solde et transactions |
| Onglet Coupons | `tabs/CouponsTab.tsx` | Codes coupons bookmakers |

### Composants partagés

| Composant | Rôle |
|---|---|
| `BottomNav.tsx` | Barre de navigation inférieure (4 onglets) |
| `CompetitionModal.tsx` | Modal de sélection de compétition |

---

## Compétitions disponibles (17)

Ligue 1 · Premier League · La Liga · Bundesliga · Serie A · Champions League · Europa League · Championship · Eredivisie · Primeira Liga · MLS · Brasileirao · Liga MX · Liga Argentina · Chinese Super League · Coupe du Monde FIFA · Scottish Premiership

---

## Secrets requis (Supabase)

| Secret | Usage |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Authentification API Telegram |
| `GROQ_API_KEY` | Appels LLaMA 3.3 70B via Groq |
| `THESPORTSDB_KEY` | Clé API TheSportsDB |
| `SUPABASE_URL` | URL du projet Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Accès service Supabase (bypass RLS) |
| `CRON_SECRET` | Protection des endpoints CRON |
| `FACEBOOK_APP_ID` | App Facebook (OAuth) |
| `FACEBOOK_APP_SECRET` | Secret App Facebook (OAuth) |
| `WEB_APP_URL` | URL Vercel de la Mini App |

---

## Déploiement

### Edge Functions Supabase
```bash
supabase functions deploy telegram-webhook
supabase functions deploy fetch-matches
supabase functions deploy facebook-post
supabase functions deploy facebook-oauth
supabase functions deploy mini-app-api
supabase functions deploy web-portal
supabase functions deploy morning-wakeup
supabase functions deploy setup-webhook
```

### Mini App (Vercel)
```bash
cd mini-app
npm run build   # → dist/
# Vercel détecte Vite automatiquement via vercel.json
```

### Migrations Supabase
```bash
supabase db push
```
