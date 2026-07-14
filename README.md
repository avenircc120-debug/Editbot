# 🤖 Editbot — Scores de Football en Direct sur Facebook

Bot Telegram qui diffuse automatiquement les scores de football en direct sur les Pages Facebook de ses utilisateurs.

---

## Flux principal

```
TheSportsDB API
     │
     ▼  (CRON chaque minute)
fetch-matches ──── upsert ──── matchs_index (Supabase PostgreSQL)
     │
     │  score ou statut changé ?
     ▼
facebook-post ──── poste ──── Pages Facebook des utilisateurs
                              (uniquement les matchs activés dans broadcast_selections)
```

Le bot Telegram répond en temps réel via webhook.
L'IA (Groq / LLaMA 3.3 70B) gère la **conversation libre** uniquement — elle ne fait aucun pronostic.
Tout ce qui concerne la compétition, Facebook, le wallet et les coupons est renvoyé vers la **Mini App**.

---

## Stack

| Couche | Technologie |
|---|---|
| Runtime backend | Supabase Edge Functions (Deno) |
| Base de données | Supabase PostgreSQL + Row Level Security |
| IA conversationnelle | Groq — LLaMA 3.3 70B (`llama-3.3-70b-versatile`, 500 tokens, temp 0.7) |
| Données sportives | TheSportsDB API (`eventsnextleague` + `eventspastleague`) |
| Bot | Telegram Bot API (webhook) |
| Mini App | React 19 + Vite 7 — déployé sur Vercel |

---

## Edge Functions

| Fonction | Déclencheur | Rôle |
|---|---|---|
| `telegram-webhook` | Webhook Telegram | Répond aux messages. Scores via regex → TheSportsDB. Conversation libre → Groq. Tout le reste → Mini App. |
| `fetch-matches` | CRON (chaque minute) | Récupère les prochains matchs des 17 ligues via TheSportsDB, upsert dans `matchs_index`, appelle `facebook-post` si score/statut changé |
| `facebook-post` | Appelé par `fetch-matches` | Poste le score sur les Pages Facebook des utilisateurs ayant activé ce match dans `broadcast_selections`. Gère l'idempotence et les tokens révoqués. |
| `facebook-oauth` | Lien OAuth | Flux OAuth Facebook v19 — nonce CSRF usage unique, expire 10 min |
| `mini-app-api` | Mini App Telegram | API REST — auth via `initData` Telegram, retourne token Bearer |
| `web-portal` | Lien web depuis Telegram | API REST — auth via `web_access_token` (`user_profiles`), sert Wallet / Facebook / Coupons / Matchs hors Telegram |
| `morning-wakeup` | CRON quotidien | Envoie la liste des matchs du jour **pour la compétition de chaque utilisateur** (silence si aucun match) |
| `setup-webhook` | Manuel | Enregistre l'URL webhook auprès de l'API Telegram |

---

## Modules partagés (`_shared/`)

| Fichier | Rôle |
|---|---|
| `config.ts` | Constantes `THESPORTSDB`, `GROQ`, liste `LEAGUES` (17 compétitions), `SYSTEM_PROMPT` |
| `groq.ts` | `chatAssistant(history, contexte)` — conversation naturelle uniquement, aucun calcul de probabilité |
| `thesportsdb.ts` | `getProchainMatchsLigue`, `getDerniersMatchsLigue`, `filtrerProchains`, type `TsdbMatch` |
| `facebook.ts` | `posterSurPage(pageId, token, message)` — Graph API Facebook |
| `quota.ts` | `consommerQuota`, `lireQuotas` — limite les appels TheSportsDB via `quota_journalier` |
| `templates.ts` | `messageReveilMatinal()`, `formatScoreFacebook()` |

---

## Logique du bot (telegram-webhook)

### Détection d'intention par regex (sans Groq)

| Regex | Réponse |
|---|---|
| `en direct / live / score maintenant` | Matchs `inprogress` de la compétition suivie |
| `aujourd'hui / ce soir / matchs du jour` | Matchs du jour de la compétition suivie |
| `programme / calendrier / prochains matchs` | Programme 7 jours |
| `connecter / ajouter … facebook` | Lien OAuth Facebook direct (valable 10 min) |
| `compétition / coupon / wallet / facebook / page` | Renvoi vers la Mini App |

### Conversation Groq
- Injectée uniquement si aucune regex ne matche
- Contexte injecté : compétition suivie + matchs J-1 à J+7 (30 max) en temps réel
- Historique sauvegardé dans `bot_sessions` (20 derniers messages)
- Bouton Mini App joint à chaque réponse

### Boutons inline
- **`🔴 En direct`** → callback `voir_direct`
- **`📅 Aujourd'hui`** → callback `matchs_jour`
- **`📆 Programme 7j`** → callback `voir_programme`
- **`🟢 Ouvrir la Mini App`** → `web_app: { url: WEB_APP_URL }`

---

## Base de données — tables actives

| Table | Colonnes clés | Rôle |
|---|---|---|
| `user_profiles` | `telegram_user_id`, `competition_suivie`, `competition_suivie_id`, `web_access_token` | Profil utilisateur — créé automatiquement au premier message |
| `bot_sessions` | `chat_id`, `history` (JSONB) | Historique de conversation Groq (20 messages max) |
| `matchs_index` | `match_id`, `tournament_id`, `status`, `home_score`, `away_score`, `match_date` | Source de vérité des scores — upsert à chaque CRON |
| `broadcast_selections` | `telegram_user_id`, `match_id`, `is_active` | Matchs activés par l'utilisateur pour diffusion Facebook |
| `facebook_connections` | `telegram_user_id`, `fb_page_id`, `fb_page_access_token`, `is_active`, `last_post_at` | Pages Facebook connectées (token long-lived 60 jours) |
| `facebook_posts_log` | `connection_id`, `match_id`, `post_date`, `status` | Log des publications — idempotence UNIQUE(connection_id, match_id, post_date) |
| `facebook_oauth_states` | `nonce`, `telegram_user_id`, `expires_at` | Nonces CSRF OAuth — usage unique, expire 10 min |
| `quota_journalier` | compteur d'appels | Limite les appels TheSportsDB par jour |
| `wallets` | `telegram_user_id`, `balance` | Solde en FCFA |
| `wallet_transactions` | `type`, `amount`, `status`, `methode`, `note` | Dépôts/retraits — statut : `en_attente` / `validée` / `refusée` |
| `coupons` | `bookmaker`, `code`, `description`, `price`, `active` | Codes promo bookmakers |

### Fonctions SQL

| Fonction | Rôle |
|---|---|
| `purger_oauth_states_expires()` | Supprime les nonces OAuth expirés |
| `purger_facebook_posts_log()` | Purge les logs de publication > 30 jours |
| `supprimer_donnees_utilisateur(telegram_user_id)` | RGPD — suppression complète des données d'un utilisateur |

---

## Statuts des matchs (TheSportsDB → Supabase)

| Code TheSportsDB | Statut normalisé |
|---|---|
| `FT` `AET` `PEN` | `finished` |
| `HT` `1H` `2H` `ET` | `inprogress` |
| `PST` `CANC` `ABD` | `postponed` |
| Tout autre | `scheduled` |

---

## Mini App Telegram (`mini-app/`)

Déployée sur Vercel. SPA React 19 + Vite 7. Auth : `initData` Telegram → token Bearer (localStorage).

### 4 onglets

| Onglet | Fichier | Fonctionnalités |
|---|---|---|
| **Matchs** | `tabs/MatchsTab.tsx` | Compétition suivie en en-tête, filtres Tous / En direct / Aujourd'hui, 4 sections (live / aujourd'hui / programme / terminés), toggle "Diffuser" par match (optimiste + rollback) |
| **Facebook** | `tabs/FacebookTab.tsx` | Pages connectées avec date du dernier post, bouton déconnecter, bouton connecter nouvelle page (OAuth) |
| **Wallet** | `tabs/WalletTab.tsx` | Solde FCFA, historique 20 transactions, bottom sheet Dépôt/Retrait (Orange Money, Wave, MTN, Autre) |
| **Coupons** | `tabs/CouponsTab.tsx` | Codes promo bookmakers, ajout (bookmaker, code, description, prix FCFA), suppression |

### Composants partagés

| Composant | Rôle |
|---|---|
| `BottomNav.tsx` | Barre de navigation 4 onglets |
| `CompetitionModal.tsx` | Modal de sélection de compétition (17 ligues) |

---

## web-portal — API REST (Mon espace)

Auth : `?token=web_access_token` dans l'URL (généré par le bot Telegram).

| Méthode | Action |
|---|---|
| `GET` (défaut) | Wallet + 20 transactions + pages Facebook actives + coupons actifs |
| `GET ?action=matches` | Matchs + IDs en diffusion (`filter=live|today|all`) |
| `GET ?action=fb_connect_url` | Génère l'URL OAuth Facebook |
| `POST { wallet }` | Crée une transaction (statut `en_attente`) |
| `POST { disconnectFbPageId }` | Désactive une page Facebook |
| `POST { broadcast }` | Active/désactive la diffusion d'un match |
| `POST { coupon }` | Ajoute un coupon |
| `POST { deleteCouponId }` | Soft delete d'un coupon (`active = false`) |

---

## Diffusion Facebook — garanties

- **Idempotence** : UNIQUE(connection_id, match_id, post_date) — un seul post par connexion par match par jour
- **Isolation** : une erreur sur une page ne bloque pas les autres
- **Tokens révoqués** : désactivation automatique de la connexion + notification Telegram à l'utilisateur

---

## Compétitions disponibles (17)

| Compétition | ID TheSportsDB |
|---|---|
| Ligue 1 🇫🇷 | 4334 |
| Premier League 🏴󠁧󠁢󠁥󠁮󠁧󠁿 | 4328 |
| La Liga 🇪🇸 | 4335 |
| Bundesliga 🇩🇪 | 4331 |
| Serie A 🇮🇹 | 4332 |
| Champions League 🏆 | 4480 |
| Europa League 🟠 | 4481 |
| Championship 🏴󠁧󠁢󠁥󠁮󠁧󠁿 | 4329 |
| Eredivisie 🇳🇱 | 4337 |
| Primeira Liga 🇵🇹 | 4344 |
| MLS 🇺🇸 | 4346 |
| Brasileirao 🇧🇷 | 4351 |
| Liga MX 🇲🇽 | 4350 |
| Liga Argentina 🇦🇷 | 4406 |
| Chinese Super League 🇨🇳 | 4359 |
| Coupe du Monde FIFA 🌍 | 4429 |
| Scottish Premiership 🏴󠁧󠁢󠁳󠁣󠁴󠁿 | 4330 |

---

## Secrets requis (Supabase)

| Secret | Usage |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Authentification API Telegram |
| `GROQ_API_KEY` | Appels LLaMA 3.3 70B via Groq |
| `THESPORTSDB_KEY` | Clé API TheSportsDB (fallback : tier gratuit public) |
| `SUPABASE_URL` | URL du projet Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Accès service Supabase (bypass RLS) |
| `CRON_SECRET` | Sécurise les endpoints `fetch-matches` et `facebook-post` |
| `FACEBOOK_APP_ID` | App Facebook (OAuth v19) |
| `FACEBOOK_APP_SECRET` | Secret App Facebook |
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
# vercel.json : buildCommand=npm run build, outputDirectory=dist, framework=vite
# Rewrite /* → /index.html (SPA)
```

### Migrations Supabase
```bash
supabase db push
```
