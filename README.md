# Editbot — Agent IA de développement autonome

Bot Telegram propulsé par Groq (llama3-70b-8192) pour modifier votre projet GitHub via langage naturel et déployer automatiquement sur Supabase.

## Architecture

```
Telegram → Edge Function (Supabase/Deno) → Groq AI → GitHub API → GitHub Actions → Supabase Deploy
                                                                          ↓
                                                               Notification Telegram (succès/échec)
```

## Commandes

| Commande | Description |
|----------|-------------|
| `/start` | Présentation du bot |
| `/ls` | Lister tous les fichiers du projet |
| `/read [fichier]` | Lire un fichier spécifique |
| `/status` | Statut du dernier déploiement GitHub Actions |
| Texte libre | L'agent analyse et modifie le code selon votre intention |

## Setup

### 1. Secrets GitHub Actions à configurer

Dans `Settings → Secrets and variables → Actions` du repo GitHub :

| Secret | Description |
|--------|-------------|
| `SUPABASE_ACCESS_TOKEN` | Token d'accès Supabase |
| `SUPABASE_PROJECT_REF` | `jxrwgcsbomqvvchvkkdt` |
| `TELEGRAM_BOT_TOKEN` | Token du bot Telegram |
| `TELEGRAM_CHAT_ID` | Votre chat ID Telegram (obtenez-le via @userinfobot) |
| `GROQ_API_KEY` | Clé API Groq |
| `GITHUB_ACCESS_TOKEN` | Token GitHub (déjà utilisé par le bot) |
| `GITHUB_REPO` | `avenircc120-debug/Editbot` |

### 2. Configurer le Webhook Telegram

Après le premier déploiement, exécutez :

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://jxrwgcsbomqvvchvkkdt.supabase.co/functions/v1/telegram-agent"}'
```

### 3. Permissions GitHub Token

Le token GitHub doit avoir les permissions :
- `repo` (lecture/écriture sur les repos)
- `workflow` (déclencher GitHub Actions)

## Flux de travail

1. Envoyez un message naturel au bot : *"Ajoute une route /health dans le serveur Express"*
2. Le bot scanne l'arborescence GitHub, lit les fichiers clés
3. Groq génère les modifications en JSON structuré
4. Le bot applique les changements via l'API GitHub (avec SHA correct)
5. GitHub Actions détecte le push → déploie sur Supabase
6. Le bot vous notifie du résultat (succès ✅ ou échec ❌ avec analyse IA)
