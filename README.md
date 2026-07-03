# FootBot — Analyse Football IA

Bot Telegram expert football propulsé par l'IA (Groq + SofaScore), pour des analyses, classements, stats et pronostics en temps réel.

## Architecture

```
Telegram → Edge Function (Supabase/Deno) → SofaScore API (scraping, sans clé)
                                         → Groq AI (llama-3.3-70b) → analyses & pronostics
```

## Commandes

| Commande | Description |
|----------|-------------|
| `/live` | Matchs en direct (ligues majeures) |
| `/auj` | Matchs du jour |
| `/classement [ligue]` | Classement d'une ligue |
| `/equipe [nom]` | Infos + forme d'une équipe |
| `/joueur [nom]` | Stats d'un joueur |
| `/h2h [e1] vs [e2]` | Historique confrontations |
| `/pronostic [e1] vs [e2]` | Pronostic IA détaillé |
| Texte libre | Question football → réponse IA |

## Ligues supportées

`premier` · `laliga` · `ligue1` · `bundesliga` · `seriea` · `ucl`

## Source de données

**SofaScore** (API non-officielle) — headers navigateur pour éviter le blocage, aucune clé requise.

## Setup Supabase

Secrets dans le projet `jxrwgcsbomqvvchvkkdt` (déjà configurés) :

| Secret | Description |
|--------|-------------|
| `TELEGRAM_BOT_TOKEN` | Token du bot Telegram |
| `GROQ_API_KEY` | Clé API Groq |

## Déploiement

```bash
supabase functions deploy telegram-agent --project-ref jxrwgcsbomqvvchvkkdt
```

Ou automatiquement via GitHub Actions au push sur `main`.

## Webhook Telegram

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://jxrwgcsbomqvvchvkkdt.supabase.co/functions/v1/telegram-agent"}'
```
