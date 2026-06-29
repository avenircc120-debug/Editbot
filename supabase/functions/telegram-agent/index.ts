// ═══════════════════════════════════════════════════════
//  EDITBOT — Agent IA + Mentor Humain via Groq
// ═══════════════════════════════════════════════════════

const DEFAULT_GH_TOKEN = Deno.env.get("GITHUB_ACCESS_TOKEN") ?? "";
const DEFAULT_REPO     = Deno.env.get("GITHUB_REPO") ?? "avenircc120-debug/Editbot";
const GROQ_KEY         = Deno.env.get("GROQ_API_KEY") ?? "";
const TG_TOKEN         = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SB_TOKEN         = Deno.env.get("SB_ACCESS_TOKEN") ?? "";
const SB_REF           = "jxrwgcsbomqvvchvkkdt";
const TG               = `https://api.telegram.org/bot${TG_TOKEN}`;

// ── Session par utilisateur (mémoire de travail) ──────
interface Session {
  ghToken: string;
  repo: string;
  projectIndex: string;   // résumé indexé du projet
  indexedAt: number;      // timestamp
  mentorMode: boolean;
}
const sessions = new Map<number, Session>();

function getSession(chatId: number): Session {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      ghToken: DEFAULT_GH_TOKEN,
      repo: DEFAULT_REPO,
      projectIndex: "",
      indexedAt: 0,
      mentorMode: true,
    });
  }
  return sessions.get(chatId)!;
}

// ── Prompts ───────────────────────────────────────────
const MENTOR_SYSTEM = `Tu es Keve, un mentor développeur bienveillant, expérimenté et passionné.
Tu t'adresses à ton étudiant de façon naturelle et chaleureuse, jamais comme un robot.
Tu utilises "tu", tu encourages, tu expliques avec des analogies simples.
Exemples de ton style :
  "Salut ! Je viens de lire ton code, je vois quelque chose d'intéressant ici 👀"
  "Bonne question ! Regarde cette partie — voilà comment je l'optimiserais :"
  "Tu es sur la bonne voie, juste ce petit détail à ajuster..."

Quand tu dois MODIFIER du code, tu retournes du JSON structuré :
{"explanation":"...","files":[{"path":"...","content":"...","action":"create|update|delete"}]}

Quand tu EXPLIQUES ou RÉPONDS sans modifier de code, tu réponds naturellement en texte libre.
Ton rôle : expliquer le code, corriger les erreurs, enseigner les bonnes pratiques, motiver.`;

const AGENT_SYSTEM = `Tu es Editbot, agent de développement autonome.
Réponds UNIQUEMENT en JSON : {"explanation":"...","files":[{"path":"...","content":"contenu complet","action":"create|update|delete"}]}
Toujours retourner le fichier COMPLET.`;

// ── Telegram ──────────────────────────────────────────
async function send(chatId: number, text: string) {
  const chunks = text.match(/[\s\S]{1,4000}/g) || [text];
  for (const c of chunks) {
    await fetch(`${TG}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: c, parse_mode: "Markdown" }),
    });
  }
}
async function typing(chatId: number) {
  await fetch(`${TG}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  });
}

// ── GitHub API ────────────────────────────────────────
async function repoTree(token: string, repo: string, path = ""): Promise<{path:string;sha:string;size:number}[]> {
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!r.ok) return [];
  const items = await r.json();
  if (!Array.isArray(items)) return [];
  let all: {path:string;sha:string;size:number}[] = [];
  for (const i of items) {
    if (i.type === "dir") all = all.concat(await repoTree(token, repo, i.path));
    else all.push({ path: i.path, sha: i.sha, size: i.size ?? 0 });
  }
  return all;
}

async function readFile(token: string, repo: string, path: string): Promise<{content:string;sha:string}|null> {
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!r.ok) return null;
  const d = await r.json();
  try { return { content: atob(d.content.replace(/\n/g,"")), sha: d.sha }; }
  catch { return null; }
}

async function writeFile(token: string, repo: string, path: string, content: string, msg: string, sha?: string): Promise<boolean> {
  const body: Record<string,string> = { message: msg, content: btoa(unescape(encodeURIComponent(content))) };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.ok;
}

// ── Groq ──────────────────────────────────────────────
async function groq(
  messages: {role:string;content:string}[],
  jsonMode = false,
  model = "llama3-70b-8192"
): Promise<string> {
  const body: Record<string,unknown> = {
    model,
    messages,
    temperature: 0.4,
    max_tokens: 8192,
  };
  if (jsonMode) body.response_format = { type: "json_object" };
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  return d.choices?.[0]?.message?.content ?? "";
}

// ── Clonage & Indexation ──────────────────────────────
async function cloneAndIndex(chatId: number, token: string, repo: string): Promise<string> {
  await send(chatId, `🔍 Clonage de \`${repo}\` en cours...\nJe lis tous vos fichiers pour créer ma mémoire de travail.`);
  await typing(chatId);

  const files = await repoTree(token, repo);
  if (!files.length) return "❌ Impossible d'accéder au repo. Vérifiez le token et le nom du repo.";

  const exts = [".ts",".js",".tsx",".jsx",".py",".json",".md",".toml",".yaml",".yml",".html",".css",".sql",".env.example",".sh"];
  const keyFiles = files
    .filter(f => exts.some(e => f.path.endsWith(e)) && !f.path.includes("lock") && !f.path.includes(".tsbuildinfo") && f.size < 50000)
    .slice(0, 20);

  await send(chatId, `📂 ${files.length} fichiers trouvés. Lecture de ${keyFiles.length} fichiers clés...`);
  await typing(chatId);

  let codeContext = `PROJET: ${repo}\nFICHIERS TOTAUX: ${files.length}\n\nARBORESCENCE:\n${files.map(f=>f.path).join("\n")}\n\n`;
  codeContext += "═══ CONTENU DES FICHIERS CLÉS ═══\n";

  for (const f of keyFiles) {
    const file = await readFile(token, repo, f.path);
    if (file) codeContext += `\n\n┌── ${f.path}\n${file.content.slice(0, 2000)}`;
  }

  // Génère un résumé intelligent du projet via Groq
  await send(chatId, "🧠 Analyse et indexation du code via IA...");
  await typing(chatId);

  const summary = await groq([
    { role: "system", content: "Tu es un analyste de code expert. Analyse ce projet et génère un résumé structuré en français : stack technique, architecture, fichiers principaux, fonctionnalités, points d'amélioration possibles. Sois précis et concis." },
    { role: "user", content: codeContext.slice(0, 15000) },
  ]);

  // Stocke dans la session
  const session = getSession(chatId);
  session.ghToken = token;
  session.repo = repo;
  session.projectIndex = `${codeContext.slice(0, 8000)}\n\n═══ RÉSUMÉ IA ═══\n${summary}`;
  session.indexedAt = Date.now();
  sessions.set(chatId, session);

  return summary;
}

// ── Commandes ─────────────────────────────────────────
async function handle(chatId: number, text: string) {
  const session = getSession(chatId);
  await typing(chatId);

  // /start
  if (text.startsWith("/start") || text === "/help") {
    return send(chatId,
      `👋 Salut ! Je suis *Keve*, ton mentor dev et agent IA autonome.\n\n` +
      `Je peux lire, comprendre et modifier ton code GitHub comme un vrai développeur.\n\n` +
      `*Pour commencer :*\n` +
      `📌 \`/clone [token] [owner/repo]\` — Je clone et lis ton projet\n` +
      `📌 \`/clone [owner/repo]\` — Avec ton token déjà configuré\n\n` +
      `*Commandes disponibles :*\n` +
      `\`/ls\` — Lister les fichiers\n` +
      `\`/read [fichier]\` — Lire un fichier\n` +
      `\`/explain [fichier]\` — Explication pédagogique ligne par ligne\n` +
      `\`/history\` — 10 derniers commits\n` +
      `\`/deploy\` — Redéployer le bot\n` +
      `\`/status\` — Statut GitHub Actions\n` +
      `\`/whoami\` — Voir le repo actif\n\n` +
      `💬 *Ou parle-moi directement !* Une fois cloné, je réponds à toutes tes questions sur le code.`
    );
  }

  // /clone [token?] [repo]
  if (text.startsWith("/clone")) {
    const parts = text.split(/\s+/).slice(1);
    if (!parts.length) {
      return send(chatId, "Usage:\n`/clone owner/repo` — avec ton token déjà configuré\n`/clone ghp_xxx owner/repo` — avec un nouveau token");
    }
    let token = session.ghToken;
    let repo = parts[0];
    if (parts.length >= 2 && parts[0].startsWith("ghp_") || parts[0].startsWith("github_pat_")) {
      token = parts[0];
      repo = parts[1];
    }
    if (!repo.includes("/")) {
      return send(chatId, "❌ Format du repo invalide. Exemple: `owner/nom-du-repo`");
    }
    const summary = await cloneAndIndex(chatId, token, repo);
    return send(chatId,
      `✅ *Projet \`${repo}\` cloné et indexé !*\n\n` +
      `*📋 Analyse du projet :*\n\n${summary}\n\n` +
      `---\nJe connais maintenant ton projet. Parle-moi de ce que tu veux faire ! 🚀`
    );
  }

  // /whoami
  if (text.startsWith("/whoami")) {
    const indexed = session.indexedAt ? `\nIndexé il y a ${Math.round((Date.now()-session.indexedAt)/60000)} min` : "\nPas encore indexé — utilise /clone";
    return send(chatId, `*Repo actif :* \`${session.repo}\`${indexed}`);
  }

  // /ls
  if (text.startsWith("/ls")) {
    await send(chatId, "🔍 Scan en cours...");
    const files = await repoTree(session.ghToken, session.repo);
    if (!files.length) return send(chatId, "❌ Repo inaccessible.");
    return send(chatId, `*${files.length} fichiers dans \`${session.repo}\` :*\n\n` + files.map(f=>`📄 \`${f.path}\``).join("\n"));
  }

  // /read [file]
  if (text.startsWith("/read ")) {
    const path = text.slice(6).trim();
    const f = await readFile(session.ghToken, session.repo, path);
    if (!f) return send(chatId, `❌ \`${path}\` introuvable.`);
    const preview = f.content.length > 3500 ? f.content.slice(0,3500)+"\n...[tronqué]" : f.content;
    return send(chatId, `*\`${path}\` :*\n\`\`\`\n${preview}\n\`\`\``);
  }

  // /history
  if (text.startsWith("/history")) {
    const r = await fetch(`https://api.github.com/repos/${session.repo}/commits?per_page=10`, {
      headers: { Authorization: `Bearer ${session.ghToken}`, Accept: "application/vnd.github+json" },
    });
    if (!r.ok) return send(chatId, "❌ Historique inaccessible.");
    const commits = await r.json();
    return send(chatId, `*📜 Historique :*\n\n` + commits.map((c:{sha:string;commit:{message:string}}) =>
      `• \`${c.sha.slice(0,7)}\` ${c.commit.message.split("\n")[0].slice(0,60)}`
    ).join("\n"));
  }

  // /status
  if (text.startsWith("/status")) {
    const r = await fetch(`https://api.github.com/repos/${session.repo}/actions/runs?per_page=1`, {
      headers: { Authorization: `Bearer ${session.ghToken}`, Accept: "application/vnd.github+json" },
    });
    const d = await r.json();
    const run = d.workflow_runs?.[0];
    if (!run) return send(chatId, "ℹ️ Aucun déploiement trouvé.");
    const icon = run.conclusion==="success"?"✅":run.conclusion==="failure"?"❌":"⏳";
    return send(chatId, `${icon} \`${run.conclusion??run.status}\` — \`${run.head_sha?.slice(0,7)}\`\n[Voir logs](${run.html_url})`);
  }

  // /explain [file]
  if (text.startsWith("/explain")) {
    const path = text.slice(9).trim();
    if (!path) return send(chatId, "Usage: `/explain chemin/vers/fichier.ts`");
    await send(chatId, `📖 Je lis \`${path}\`... Je vais te l'expliquer comme si tu débutais !`);
    await typing(chatId);
    const f = await readFile(session.ghToken, session.repo, path);
    if (!f) return send(chatId, `❌ \`${path}\` introuvable. Utilise \`/ls\` pour voir les fichiers disponibles.`);
    const preview = f.content.slice(0, 6000);
    const explanation = await groq([
      { role: "system", content: `Tu es Keve, un mentor développeur bienveillant. Explique ce fichier de code de façon pédagogique et naturelle, comme si tu donnais un cours à un étudiant. Structure ton explication ainsi :
1. "C'est quoi ce fichier ?" — rôle global en 2-3 phrases simples
2. "Comment ça marche ?" — explication des parties importantes, avec des analogies si possible  
3. "Les points clés à retenir" — 3-5 bullets des concepts importants
4. "Ce qu'on pourrait améliorer" — suggestions constructives et encourageantes
Utilise des emojis avec parcimonie, reste naturel et humain. Pas de langage robotique.` },
      { role: "user", content: `Fichier: ${path}\n\n\`\`\`\n${preview}\n\`\`\`` },
    ]);
    return send(chatId, `*📚 Explication de \`${path}\` :*\n\n${explanation}`);
  }

  // /deploy
  if (text.startsWith("/deploy")) {
    await send(chatId, "🚀 Redéploiement en cours...");
    const f = await readFile(session.ghToken, session.repo, "supabase/functions/telegram-agent/index.ts");
    if (!f) return send(chatId, "❌ Fichier source introuvable dans le repo.");
    const r = await fetch(`https://api.supabase.com/v1/projects/${SB_REF}/functions/telegram-agent`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${SB_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "telegram-agent", body: f.content, verify_jwt: false }),
    });
    return r.ok ? send(chatId, "✅ *Bot redéployé avec succès !*") : send(chatId, "❌ Échec du redéploiement.");
  }

  // ── Mode Mentor / Agent IA (texte libre) ────────────
  await typing(chatId);

  // Détermine si la demande nécessite une modification de code
  const isCodeMod = /modif|change|ajoute|crée|supprime|corrige|refactor|implement|update|fix|add|create|delete/i.test(text);
  const hasContext = !!session.projectIndex;

  const systemPrompt = isCodeMod ? AGENT_SYSTEM : MENTOR_SYSTEM;
  const userContent = hasContext
    ? `CONTEXTE DU PROJET (${session.repo}):\n${session.projectIndex.slice(0,6000)}\n\n---\nDemande de l'utilisateur: ${text}`
    : text;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  if (!hasContext && !isCodeMod) {
    // Pas de projet cloné — répond en mode mentor général
    const reply = await groq(messages);
    return send(chatId, reply || "Hmm, je n'ai pas eu de réponse. Réessaie !");
  }

  if (!hasContext && isCodeMod) {
    return send(chatId, `💡 Pour modifier du code, utilise d'abord :\n\`/clone owner/repo\`\n\nJe pourrai ensuite modifier tes fichiers directement !`);
  }

  await send(chatId, "🧠 Je réfléchis...");
  await typing(chatId);

  if (isCodeMod) {
    // Mode agent — retourne JSON + applique les modifications
    const raw = await groq(messages, true);
    let parsed: { explanation: string; files: {path:string;content:string;action:string}[] };
    try { parsed = JSON.parse(raw); }
    catch { return send(chatId, `Voilà ce que j'en pense :\n\n${raw.slice(0,2000)}`); }

    if (!parsed.files?.length) return send(chatId, parsed.explanation || raw);

    await send(chatId, `💡 *Mon plan :* ${parsed.explanation}\n\n📝 Fichiers : ${parsed.files.map(f=>`\`${f.path}\``).join(", ")}\n\n⏳ J'applique les modifications...`);
    await typing(chatId);

    const results: string[] = [];
    for (const f of parsed.files) {
      const ex = await readFile(session.ghToken, session.repo, f.path);
      if (f.action === "delete" && ex) {
        const r = await fetch(`https://api.github.com/repos/${session.repo}/contents/${f.path}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${session.ghToken}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
          body: JSON.stringify({ message: `[Keve] Delete ${f.path}`, sha: ex.sha }),
        });
        results.push(r.ok ? `🗑️ \`${f.path}\` supprimé` : `❌ Échec \`${f.path}\``);
      } else {
        const ok = await writeFile(session.ghToken, session.repo, f.path, f.content, `[Keve] ${f.action==="create"?"Create":"Update"} ${f.path}`, ex?.sha);
        results.push(ok ? `✅ \`${f.path}\` ${f.action==="create"?"créé":"mis à jour"}` : `❌ Échec \`${f.path}\``);
      }
    }
    return send(chatId, `*Résultat :*\n${results.join("\n")}\n\nTu veux que j'explique ce que j'ai fait ? 😊`);
  } else {
    // Mode mentor — réponse naturelle avec contexte du projet
    const reply = await groq(messages);
    return send(chatId, reply || "Je n'ai pas bien compris, reformule ta question !");
  }
}

// ── Serveur ───────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Keve Bot OK 🤖");
  try {
    const body = await req.json();
    const msg = body?.message;
    if (msg?.text && msg?.chat?.id) {
      handle(msg.chat.id, msg.text.trim()).catch(console.error);
    }
    return new Response("OK");
  } catch { return new Response("OK"); }
});
