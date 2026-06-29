// ═══════════════════════════════════════════════════════
//  EDITBOT — Keve, Agent IA + Mentor Dev
// ═══════════════════════════════════════════════════════

const DEFAULT_GH_TOKEN = Deno.env.get("GITHUB_ACCESS_TOKEN") ?? "";
const DEFAULT_REPO     = Deno.env.get("GITHUB_REPO") ?? "avenircc120-debug/Editbot";
const GROQ_KEY         = Deno.env.get("GROQ_API_KEY") ?? "";
const TG_TOKEN         = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SB_TOKEN         = Deno.env.get("SB_ACCESS_TOKEN") ?? "";
const SB_REF           = "jxrwgcsbomqvvchvkkdt";
const TG               = `https://api.telegram.org/bot${TG_TOKEN}`;

// ── Session par utilisateur ───────────────────────────
interface Session {
  ghToken: string;
  repo: string;
  projectIndex: string;
  indexedAt: number;
  history: { role: string; content: string }[];
}

const sessions = new Map<number, Session>();

function getSession(chatId: number): Session {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      ghToken: DEFAULT_GH_TOKEN,
      repo: DEFAULT_REPO,
      projectIndex: "",
      indexedAt: 0,
      history: [],
    });
  }
  return sessions.get(chatId)!;
}

function addHistory(session: Session, role: string, content: string) {
  session.history.push({ role, content });
  if (session.history.length > 20) session.history = session.history.slice(-20);
}

// ── Telegram ──────────────────────────────────────────
async function send(chatId: number, text: string) {
  const chunks = text.match(/[\s\S]{1,4000}/g) ?? [text];
  for (const c of chunks) {
    await fetch(`${TG}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: c, parse_mode: "Markdown" }),
    }).catch(() => {
      // retry without markdown if parse fails
      return fetch(`${TG}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: c }),
      });
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

// ── Groq ──────────────────────────────────────────────
// Modèles stables et disponibles sur Groq
const MODELS = [
  "llama-3.3-70b-versatile",
  "llama3-8b-8192",
  "gemma2-9b-it",
];

async function groq(
  messages: { role: string; content: string }[],
  jsonMode = false,
): Promise<string> {
  for (const model of MODELS) {
    try {
      const body: Record<string, unknown> = {
        model,
        messages,
        temperature: 0.5,
        max_tokens: 4096,
      };
      if (jsonMode) body.response_format = { type: "json_object" };

      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GROQ_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!r.ok) {
        const err = await r.text();
        console.error(`Groq error (${model}):`, r.status, err);
        continue;
      }

      const d = await r.json();
      const content = d.choices?.[0]?.message?.content;
      if (content && typeof content === "string" && content.trim()) {
        return content.trim();
      }
      console.error(`Groq empty response (${model}):`, JSON.stringify(d));
    } catch (e) {
      console.error(`Groq exception (${model}):`, e);
    }
  }
  return "";
}

// ── GitHub API ────────────────────────────────────────
async function repoTree(
  token: string,
  repo: string,
  path = "",
): Promise<{ path: string; sha: string; size: number }[]> {
  const r = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (!r.ok) return [];
  const items = await r.json();
  if (!Array.isArray(items)) return [];
  let all: { path: string; sha: string; size: number }[] = [];
  for (const i of items) {
    if (i.type === "dir") {
      all = all.concat(await repoTree(token, repo, i.path));
    } else {
      all.push({ path: i.path, sha: i.sha, size: i.size ?? 0 });
    }
  }
  return all;
}

async function readFile(
  token: string,
  repo: string,
  path: string,
): Promise<{ content: string; sha: string } | null> {
  const r = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (!r.ok) return null;
  const d = await r.json();
  try {
    return { content: atob(d.content.replace(/\n/g, "")), sha: d.sha };
  } catch {
    return null;
  }
}

async function writeFile(
  token: string,
  repo: string,
  path: string,
  content: string,
  msg: string,
  sha?: string,
): Promise<boolean> {
  const body: Record<string, string> = {
    message: msg,
    content: btoa(unescape(encodeURIComponent(content))),
  };
  if (sha) body.sha = sha;
  const r = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  return r.ok;
}

// ── Clonage & Indexation ──────────────────────────────
async function cloneAndIndex(
  chatId: number,
  token: string,
  repo: string,
): Promise<string> {
  await send(chatId, `🔍 Je clone \`${repo}\`...\nLaisse-moi lire tous tes fichiers, je reviens !`);

  const files = await repoTree(token, repo);
  if (!files.length) {
    return "❌ Impossible d'accéder au repo. Vérifie le nom (format: `owner/repo`) ou ton token GitHub.";
  }

  const exts = [".ts", ".js", ".tsx", ".jsx", ".py", ".go", ".json", ".md", ".toml", ".yaml", ".yml", ".html", ".css", ".sql", ".sh"];
  const keyFiles = files
    .filter((f) =>
      exts.some((e) => f.path.endsWith(e)) &&
      !f.path.includes("lock") &&
      !f.path.includes(".tsbuildinfo") &&
      !f.path.includes("node_modules") &&
      f.size < 60000
    )
    .slice(0, 25);

  await send(chatId, `📂 ${files.length} fichiers trouvés ! Je lis les ${keyFiles.length} fichiers importants...`);

  let codeContext = `PROJET: ${repo}\nFICHIERS: ${files.length}\n\nARBORESCENCE:\n`;
  codeContext += files.map((f) => f.path).join("\n");
  codeContext += "\n\n═══ CONTENU ═══\n";

  for (const f of keyFiles) {
    const file = await readFile(token, repo, f.path);
    if (file) {
      codeContext += `\n\n// ── ${f.path}\n${file.content.slice(0, 2500)}`;
    }
  }

  await send(chatId, "🧠 J'analyse le code avec l'IA, encore quelques secondes...");

  const summary = await groq([
    {
      role: "system",
      content:
        "Tu es un expert en analyse de code. Analyse ce projet et génère un résumé en français, structuré ainsi :\n🔧 Stack technique\n📁 Architecture\n⚡ Fonctionnalités principales\n💡 Points à améliorer\nSois précis, bienveillant, et concis.",
    },
    { role: "user", content: codeContext.slice(0, 14000) },
  ]);

  if (!summary) return "⚠️ Projet cloné mais l'analyse IA a échoué. Tu peux quand même me poser des questions !";

  const session = getSession(chatId);
  session.ghToken = token;
  session.repo = repo;
  session.projectIndex = `${codeContext.slice(0, 8000)}\n\n═══ RÉSUMÉ ═══\n${summary}`;
  session.indexedAt = Date.now();
  session.history = [];
  sessions.set(chatId, session);

  return summary;
}

// ── Logique principale ────────────────────────────────
async function handle(chatId: number, text: string) {
  const session = getSession(chatId);
  await typing(chatId);

  // ── /start /help
  if (text.startsWith("/start") || text === "/help") {
    return send(
      chatId,
      `👋 Salut ! Je suis *Keve*, ton mentor développeur et agent IA.\n\n` +
        `Je lis ton code GitHub, je l'explique, je le corrige — comme un vrai dev senior à côté de toi.\n\n` +
        `*Pour démarrer :*\n` +
        `\`/clone owner/repo\` — Je lis tout ton projet (token déjà configuré)\n` +
        `\`/clone ghp_xxx owner/repo\` — Avec ton propre token GitHub\n\n` +
        `*Commandes :*\n` +
        `\`/ls\` — Voir les fichiers\n` +
        `\`/read chemin/fichier\` — Lire un fichier\n` +
        `\`/explain chemin/fichier\` — Explication détaillée\n` +
        `\`/history\` — Derniers commits\n` +
        `\`/whoami\` — Repo actif\n` +
        `\`/deploy\` — Redéployer\n\n` +
        `💬 Et bien sûr, tu peux juste *me parler* — je suis là !`,
    );
  }

  // ── /clone
  if (text.startsWith("/clone")) {
    const parts = text.split(/\s+/).slice(1);
    if (!parts.length) {
      return send(chatId,
        "Usage:\n`/clone owner/repo` — token déjà configuré par défaut\n`/clone ghp_xxx owner/repo` — avec ton token perso");
    }

    let token = session.ghToken;
    let repo = parts[0];

    if (parts.length >= 2 && (parts[0].startsWith("ghp_") || parts[0].startsWith("github_pat_"))) {
      token = parts[0];
      repo = parts[1];
    }

    if (!repo.includes("/")) {
      return send(chatId, `❌ Format invalide. Exemple : \`/clone MonPseudo/mon-repo\``);
    }

    const summary = await cloneAndIndex(chatId, token, repo);
    return send(
      chatId,
      `✅ *\`${repo}\` cloné et analysé !*\n\n${summary}\n\n` +
        `---\nMaintenant parle-moi de ce que tu veux faire 🚀`,
    );
  }

  // ── /whoami
  if (text.startsWith("/whoami")) {
    const age = session.indexedAt
      ? `(indexé il y a ${Math.round((Date.now() - session.indexedAt) / 60000)} min)`
      : "(pas encore indexé)";
    return send(chatId, `*Repo actif :* \`${session.repo}\` ${age}`);
  }

  // ── /ls
  if (text.startsWith("/ls")) {
    const files = await repoTree(session.ghToken, session.repo);
    if (!files.length) return send(chatId, "❌ Repo inaccessible. Vérifie le token avec `/whoami`");
    return send(
      chatId,
      `*${files.length} fichiers dans \`${session.repo}\` :*\n\n` +
        files.map((f) => `📄 \`${f.path}\``).join("\n"),
    );
  }

  // ── /read
  if (text.startsWith("/read ")) {
    const path = text.slice(6).trim();
    const f = await readFile(session.ghToken, session.repo, path);
    if (!f) return send(chatId, `❌ \`${path}\` introuvable. Utilise \`/ls\` pour voir les fichiers.`);
    const preview = f.content.length > 3500 ? f.content.slice(0, 3500) + "\n... [tronqué]" : f.content;
    return send(chatId, `*${path} :*\n\`\`\`\n${preview}\n\`\`\``);
  }

  // ── /explain
  if (text.startsWith("/explain")) {
    const path = text.slice(9).trim();
    if (!path) return send(chatId, "Usage : `/explain chemin/vers/fichier.ts`");
    await send(chatId, `📖 Je lis \`${path}\`, je te prépare une explication claire...`);
    const f = await readFile(session.ghToken, session.repo, path);
    if (!f) return send(chatId, `❌ \`${path}\` introuvable. Utilise \`/ls\` pour voir la liste.`);

    const explanation = await groq([
      {
        role: "system",
        content:
          `Tu es Keve, un mentor développeur bienveillant. Explique ce fichier de code de façon pédagogique, naturelle et encourageante, comme si tu donnais un cours à un ami :\n` +
          `1. C'est quoi ce fichier ? (2-3 phrases simples)\n` +
          `2. Comment ça fonctionne ? (parties importantes, analogies si possible)\n` +
          `3. Points clés à retenir (3-5 bullets)\n` +
          `4. Ce qu'on pourrait améliorer (suggestions positives)\n` +
          `Sois naturel, pas robotique. Évite le jargon inutile.`,
      },
      { role: "user", content: `Fichier: ${path}\n\n${f.content.slice(0, 6000)}` },
    ]);

    if (!explanation) return send(chatId, "⚠️ L'IA n'a pas pu générer une explication. Réessaie !");
    return send(chatId, `*📚 ${path} :*\n\n${explanation}`);
  }

  // ── /history
  if (text.startsWith("/history")) {
    const r = await fetch(
      `https://api.github.com/repos/${session.repo}/commits?per_page=10`,
      { headers: { Authorization: `Bearer ${session.ghToken}`, Accept: "application/vnd.github+json" } },
    );
    if (!r.ok) return send(chatId, "❌ Impossible de récupérer l'historique.");
    const commits = await r.json();
    if (!Array.isArray(commits)) return send(chatId, "❌ Repo inaccessible.");
    return send(
      chatId,
      `*📜 Derniers commits sur \`${session.repo}\` :*\n\n` +
        commits
          .map((c: { sha: string; commit: { message: string } }) =>
            `• \`${c.sha.slice(0, 7)}\` ${c.commit.message.split("\n")[0].slice(0, 60)}`
          )
          .join("\n"),
    );
  }

  // ── /status
  if (text.startsWith("/status")) {
    const r = await fetch(
      `https://api.github.com/repos/${session.repo}/actions/runs?per_page=1`,
      { headers: { Authorization: `Bearer ${session.ghToken}`, Accept: "application/vnd.github+json" } },
    );
    const d = await r.json();
    const run = d.workflow_runs?.[0];
    if (!run) return send(chatId, "ℹ️ Aucun déploiement trouvé.");
    const icon = run.conclusion === "success" ? "✅" : run.conclusion === "failure" ? "❌" : "⏳";
    return send(chatId,`${icon} \`${run.conclusion ?? run.status}\` — commit \`${run.head_sha?.slice(0, 7)}\`\n[Voir les logs](${run.html_url})`);
  }

  // ── /deploy
  if (text.startsWith("/deploy")) {
    await send(chatId, "🚀 Redéploiement en cours...");
    const f = await readFile(session.ghToken, session.repo, "supabase/functions/telegram-agent/index.ts");
    if (!f) return send(chatId, "❌ Fichier source introuvable dans le repo.");
    const r = await fetch(
      `https://api.supabase.com/v1/projects/${SB_REF}/functions/telegram-agent`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${SB_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "telegram-agent", body: f.content, verify_jwt: false }),
      },
    );
    return r.ok
      ? send(chatId, "✅ Bot redéployé avec succès !")
      : send(chatId, "❌ Échec du redéploiement.");
  }

  // ── Conversation IA libre (mentor + agent) ────────────

  // Message trop court → réponse simple sans appel IA inutile
  if (text.trim().length < 3) {
    return send(chatId, "Oui ? Je t'écoute 😊 Dis-moi ce que tu veux faire !");
  }

  // Salutations courantes
  const greetings = /^(salut|bonjour|hello|hi|hey|cc|coucou|bonsoir|yo)[!. ]*$/i;
  if (greetings.test(text.trim())) {
    const replies = [
      "Salut ! Comment je peux t'aider aujourd'hui ? 😊",
      "Hey ! Qu'est-ce qu'on fait aujourd'hui ?",
      "Coucou ! Tu veux qu'on travaille sur du code ? Dis-moi 🚀",
      "Hello ! Je suis là. Dis-moi ce que tu as en tête !",
    ];
    return send(chatId, replies[Math.floor(Math.random() * replies.length)]);
  }

  // Détecte si c'est une demande de modification de code
  const isCodeMod = !!session.projectIndex &&
    /\b(modifi|change|ajoute|crée|supprime|corrige|refactor|implémente|écri[st]|génère|update|fix|add|create|delete|rewrite)\b/i.test(text);

  // Construit les messages pour Groq
  const systemPrompt = isCodeMod
    ? `Tu es Keve, agent dev autonome. L'utilisateur veut modifier du code. Réponds UNIQUEMENT en JSON valide :
{"explanation":"Ce que tu vas faire en 1-2 phrases","files":[{"path":"chemin/fichier","content":"contenu COMPLET du fichier","action":"create|update|delete"}]}
Toujours retourner le fichier entier, jamais un extrait.`
    : `Tu es Keve, un mentor développeur bienveillant, naturel et passionné. Tu parles à un étudiant comme à un ami.
Ton style : direct, chaleureux, encourageant. Tu utilises "tu". Tu expliques simplement.
Tu n'es PAS un robot — tu es un humain qui code depuis 10 ans et adore enseigner.
Si l'utilisateur ne parle pas de code, tu peux juste avoir une conversation normale.
${session.projectIndex ? `\nCONTEXTE DU PROJET (${session.repo}) :\n${session.projectIndex.slice(0, 5000)}` : ""}`;

  const messages = [
    { role: "system", content: systemPrompt },
    ...session.history.slice(-10),
    { role: "user", content: text },
  ];

  await typing(chatId);
  const raw = await groq(messages, isCodeMod);

  if (!raw) {
    return send(chatId, "Hmm, j'ai eu un problème pour te répondre. Réessaie dans quelques secondes !");
  }

  addHistory(session, "user", text);

  if (isCodeMod) {
    let parsed: { explanation: string; files: { path: string; content: string; action: string }[] };
    try {
      parsed = JSON.parse(raw);
    } catch {
      addHistory(session, "assistant", raw);
      return send(chatId, raw.slice(0, 2000));
    }

    if (!parsed.files?.length) {
      addHistory(session, "assistant", parsed.explanation ?? raw);
      return send(chatId, parsed.explanation || raw);
    }

    await send(
      chatId,
      `💡 *Plan :* ${parsed.explanation}\n\n` +
        `📝 Fichiers : ${parsed.files.map((f) => `\`${f.path}\``).join(", ")}\n\n` +
        `⏳ J'applique les modifications sur GitHub...`,
    );

    const results: string[] = [];
    for (const f of parsed.files) {
      const ex = await readFile(session.ghToken, session.repo, f.path);
      if (f.action === "delete" && ex) {
        const r = await fetch(
          `https://api.github.com/repos/${session.repo}/contents/${f.path}`,
          {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${session.ghToken}`,
              Accept: "application/vnd.github+json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ message: `[Keve] Delete ${f.path}`, sha: ex.sha }),
          },
        );
        results.push(r.ok ? `🗑️ \`${f.path}\` supprimé` : `❌ Échec suppression \`${f.path}\``);
      } else {
        const ok = await writeFile(
          session.ghToken,
          session.repo,
          f.path,
          f.content,
          `[Keve] ${f.action === "create" ? "Create" : "Update"} ${f.path}`,
          ex?.sha,
        );
        results.push(ok
          ? `✅ \`${f.path}\` ${f.action === "create" ? "créé" : "mis à jour"}`
          : `❌ Échec \`${f.path}\``);
      }
    }

    const resultMsg = `*Résultat :*\n${results.join("\n")}\n\nTu veux que je t'explique ce que j'ai changé ? 😊`;
    addHistory(session, "assistant", resultMsg);
    return send(chatId, resultMsg);
  }

  // Réponse mentor normale
  addHistory(session, "assistant", raw);
  return send(chatId, raw);
}

// ── Serveur ───────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Keve Bot 🤖 OK");
  try {
    const body = await req.json();
    const msg = body?.message;
    if (msg?.text && msg?.chat?.id) {
      handle(msg.chat.id, msg.text.trim()).catch((e) => console.error("handle error:", e));
    }
    return new Response("OK");
  } catch {
    return new Response("OK");
  }
});
