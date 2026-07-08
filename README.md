# ⚽ Editbot Football Intelligence

> Bot Telegram de pronostics et analyses football alimenté par IA sémantique.

---

## 🏗️ Architecture

```
Utilisateur (Telegram)
        │
        ▼
┌─────────────────┐
│  telegram-agent │  ← Aucun appel Sheets pendant les conversations
└────────┬────────┘
         │
    ┌────▼─────────────────────┐
    │  Cache sémantique         │  pgvector (Supabase)
    │  analyse_groq             │  Similarité cosinus > 0.78
    │  base_connaissance        │  Réponse < 200ms si hit
    └────┬─────────────────────┘
         │ Cache miss
         ▼
┌─────────────────────────────────────────────────────┐
│                  Pipeline complet                    │
│                                                     │
│  1. web-search          Google Custom Search API    │
│     └─ Vectorise        text-embedding-004 (768d)   │
│     └─ Stocke           raw_web_data (Supabase)     │
│                                                     │
│  2. groq-analyse        Lecture raw_web_data        │
│     └─ Synthèse IA      Groq llama-3.3-70b         │
│     └─ Stocke           analyse_groq + base_conn.   │
└─────────────────────────────────────────────────────┘
         │
         ▼
  Réponse humanisée → Telegram
```

---

## 📦 Stack technique

| Composant | Technologie | Rôle |
|---|---|---|
| **Bot** | Telegram Bot API | Interface utilisateur |
| **Fonctions** | Supabase Edge Functions (Deno) | Serverless backend |
| **Recherche web** | Google Custom Search API | Collecte données brutes |
| **Embeddings** | Google text-embedding-004 (768d) | Vectorisation sémantique |
| **IA** | Groq llama-3.3-70b-versatile | Synthèse et humanisation |
| **Base de données** | Supabase PostgreSQL + pgvector | Cache vectoriel |
| **Config** | Google Sheets | Données de config (hors conversations) |
| **Auth** | Workload Identity Federation | Sans clé JSON permanente |

---

## 🗄️ Base de données (pgvector)

| Table | Rôle | Expiration |
|---|---|---|
| `raw_web_data` | Buffer de recherche brute (Google CSE) | 24h |
| `analyse_groq` | Synthèses IA avec vecteurs | 6h |
| `base_connaissance` | Mémoire long terme + templates | Permanente |

**Recherche sémantique** via `search_analyses()` et `search_knowledge()` (fonctions SQL).

---

## ⚡ Fonctions Supabase

| Fonction | Version | Rôle |
|---|---|---|
| `telegram-agent` | v58+ | Bot principal — cache sémantique en priorité |
| `web-search` | v1+ | Google CSE → vectorisation → raw_web_data |
| `groq-analyse` | v7+ | Synthèse Groq → analyse_groq + base_connaissance |
| `diffusion-telegram` | v4 | Push analyse_groq → Telegram (batch) |
| `setup-sheets` | v2+ | Scaffold des onglets Google Sheets |
| `jwks` | v5+ | OIDC Discovery + JWKS pour WIF |

---

## 📊 Google Sheets (configuration uniquement)

| Onglet | Rôle |
|---|---|
| `RAW_WEB_DATA` | Vue des données brutes collectées |
| `ANALYSE_GROQ` | Vue des synthèses IA |
| `BASE_CONNAISSANCE` | Templates de réponses humanisées |
| `PL_Stand`, `Liga_Stand`, `L1_Stand`... | Classements par compétition |

> ⚠️ Sheets est utilisé **uniquement pour la configuration et la supervision**.
> Zéro appel Sheets lors des conversations Telegram.

---

## 🔑 Secrets requis

```
TELEGRAM_BOT_TOKEN
GROQ_API_KEY
GOOGLE_API_KEY          ← Custom Search + text-embedding-004
GOOGLE_CSE_ID           ← ID moteur de recherche personnalisé
GOOGLE_VERTEX_API_KEY   ← Vertex AI (Vector Search avancé)
GOOGLE_SHEETS_ID
GOOGLE_WIF_AUDIENCE
GOOGLE_WIF_SIGNING_KEY
GOOGLE_SERVICE_ACCOUNT_EMAIL
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

---

## 🚀 Démarrage

### 1. Initialiser la base de données
```bash
supabase db push --project-ref jxrwgcsbomqvvchvkkdt
```

### 2. Scaffolder Google Sheets
```bash
curl -X POST https://jxrwgcsbomqvvchvkkdt.supabase.co/functions/v1/setup-sheets
```

### 3. Tester le pipeline
```bash
# Recherche + vectorisation
curl -X POST https://jxrwgcsbomqvvchvkkdt.supabase.co/functions/v1/web-search \
  -H "Content-Type: application/json" \
  -d '{"query": "classement Ligue 1 2025"}'

# Synthèse Groq
curl -X POST https://jxrwgcsbomqvvchvkkdt.supabase.co/functions/v1/groq-analyse \
  -H "Content-Type: application/json" \
  -d '{"query": "classement Ligue 1 2025"}'
```

### 4. Enregistrer le webhook Telegram
```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://jxrwgcsbomqvvchvkkdt.supabase.co/functions/v1/telegram-agent"
```

---

## 📐 Principes de conception

- **Sémantique > textuel** : toute recherche passe par des vecteurs (768d), jamais par des mots-clés exacts
- **Cache d'abord** : Supabase est interrogé avant tout appel externe
- **Traçabilité** : chaque recherche externe est loggée dans `raw_web_data`
- **Sheets = config** : aucun appel Sheets pendant les conversations utilisateur
- **WIF sans clé JSON** : authentification Google via Workload Identity Federation

---

*Projet : bot-foot-stats | Supabase ref : jxrwgcsbomqvvchvkkdt*
