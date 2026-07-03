# FootBot — Analyse Football IA

    Bot Telegram expert football propulse par l'IA (Groq + SofaScore), pour des analyses, classements, stats et pronostics en temps reel.

    ## Architecture

    ```
    Telegram → Edge Function (Supabase/Deno) → SofaScore API (scraping)
                                           → Groq AI (llama-3.3-70b) → analyses & pronostics
    ```

    ## Commandes

    | Commande | Description |
    |----------|-------------|
    | `/live` | Matchs en direct |
    | `/aujourd'hui` | Matchs du jour |
    | `/classement [ligue]` | Classement d'une ligue |
    | `/equipe [nom]` | Infos + forme d'une equipe |
    | `/joueur [nom]` | Stats d'un joueur |
    | `/h2h [e1] vs [e2]` | Historique confrontations |
    | `/pronostic [e1] vs [e2]` | Pronostic IA detaille |
    | Texte libre | Question football → reponse IA |

    ## Ligues supportees

    `premier` · `laliga` · `ligue1` · `bundesliga` · `seriea` · `ucl`

    ## Source de donnees

    **SofaScore** (API non-officielle) — headers navigateur pour eviter le blocage, aucune cle requise.

    ## Setup Supabase

    Secrets dans le projet `jxrwgcsbomqvvchvkkdt`:

    | Secret | Description |
    |--------|-------------|
    | `TELEGRAM_BOT_TOKEN` | Token du bot Telegram |
    | `GROQ_API_KEY` | Cle API Groq |

    ## Deploiement

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
    