import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const TELEGRAM_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY")!;
const GITHUB_TOKEN = Deno.env.get("GITHUB_ACCESS_TOKEN")!;
const GITHUB_REPO = Deno.env.get("GITHUB_REPO")!;
const SUPABASE_TOKEN = Deno.env.get("SUPABASE_ACCESS_TOKEN")!;
const SUPABASE_REF = "jxrwgcsbomqvvchvkkdt";
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const SYSTEM_PROMPT = `Tu es Editbot, un agent de développement autonome et omniscient.

Ton rôle :
- Analyser l'arborescence complète d'un projet GitHub
- Comprendre les dépendances entre fichiers
- Modifier le code de façon intelligente et cohérente selon les intentions naturelles de l'utilisateur
- Garantir que chaque modification est syntaxiquement correcte et fonctionnellement cohérente

Règles absolues :
1. Tu dois toujours retourner un JSON valide UNIQUEMENT avec cette structure :
{
  "explanation": "Explication claire de ce que tu fais et pourquoi",
  "files": [
    {
      "path": "chemin/vers/fichier.ext",
      "content": "contenu complet du fichier modifié",
      "action": "update" | "create" | "delete"
    }
  ]
}
2. Retourne TOUJOURS le fichier COMPLET, jamais d'extraits partiels
3. Sois précis sur les chemins de fichiers (respecte la casse)
4. Si tu crées plusieurs fichiers interdépendants, inclus-les tous dans la même réponse
5. Ne jamais inclure de texte hors du JSON`;

const CORRECTION_PROMPT = `Tu es un expert en débogage de code (Deno/TypeScript/Node.js/Python).
Analyse les logs d'erreur fournis et réponds en JSON :
{
  "diagnostic": "Explication claire du problème",
  "severity": "critical" | "warning" | "info",
  "fix_suggestion": "Correction concrète à apporter",
  "affected_files": ["liste des fichiers concernés"]
}`;

interface TelegramMessage {
  message?: {
    chat: { id: number };
    text?: string;
    from?: { id: number; username?: string };
  };
}

async function sendMessage(chatId: number, text: string, parseMode = "Markdown") {
  const chunks = text.match(/[\s\S]{1,4000}/g) || [text];
  for (const chunk of chunks) {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: parseMode }),
    });
  }
}

async function sendTyping(chatId: number) {
  await fetch(`${TELEGRAM_API}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  });
}

async function getRepoTree(path = ""): Promise<{ path: string; sha: string; type: string }[]> {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) return [];
  const items = await res.json();
  let allFiles: { path: string; sha: string; type: string }[] = [];
  for (const item of items) {
    if (item.type === "dir") {
      allFiles = allFiles.concat(await getRepoTree(item.path));
    } else {
      allFiles.push({ path: item.path, sha: item.sha, type: item.type });
    }
  }
  return allFiles;
}

async function getFileContent(path: string): Promise<{ content: string; sha: string } | null> {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const content = atob(data.content.replace(/\n/g, ""));
  return { content, sha: data.sha };
}

async function updateFile(path: string, content: string, message: string, sha?: string): Promise<boolean> {
  const body: Record<string, string> = {
    message,
    content: btoa(unescape(encodeURIComponent(content))),
  };
  if (sha) body.sha = sha;
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return res.ok;
}

async function deleteFile(path: string, message: string, sha: string): Promise<boolean> {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message, sha }),
  });
  return res.ok;
}

async function callGroq(messages: { role: string; content: string }[], json = true): Promise<string> {
  const body: Record<string, unknown> = {
    model: "llama3-70b-8192",
    messages,
    temperature: 0.2,
    max_tokens: 8192,
  };
  if (json) body.response_format = { type: "json_object" };

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "{}";
}

async function deployEdgeFunction(functionBody: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_REF}/functions/telegram-agent`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${SUPABASE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      slug: "telegram-agent",
      name: "telegram-agent",
      body: functionBody,
      verify_jwt: false,
    }),
  });
  if (res.ok) return { ok: true };
  const err = await res.text();
  return { ok: false, error: err };
}

async function getLastCommitStatus(): Promise<{ status: string; sha: string; url: string } | null> {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/runs?per_page=1`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const run = data.workflow_runs?.[0];
  if (!run) return null;
  return { status: run.conclusion ?? run.status, sha: run.head_sha?.slice(0, 7), url: run.html_url };
}

async function handleCommand(chatId: number, text: string) {
  await sendTyping(chatId);

  // /start
  if (text.startsWith("/start")) {
    await sendMessage(chatId,
      `🤖 *Editbot — Agent IA de développement autonome*\n\n` +
      `Je scanne votre projet GitHub et modifie le code selon vos intentions naturelles.\n\n` +
      `*Commandes :*\n` +
      `/ls — Lister tous les fichiers du projet\n` +
      `/read [fichier] — Lire un fichier spécifique\n` +
      `/deploy — Redéployer l'Edge Function maintenant\n` +
      `/status — Statut du dernier déploiement GitHub Actions\n\n` +
      `💡 Ou décrivez simplement ce que vous voulez faire en langage naturel !`
    );
    return;
  }

  // /ls
  if (text.startsWith("/ls")) {
    await sendMessage(chatId, "🔍 Scan de l'arborescence en cours...");
    const files = await getRepoTree();
    if (files.length === 0) {
      await sendMessage(chatId, "❌ Repo vide ou inaccessible.");
      return;
    }
    const tree = files.map(f => `📄 \`${f.path}\``).join("\n");
    await sendMessage(chatId, `*Arborescence (${files.length} fichiers) :*\n\n${tree}`);
    return;
  }

  // /read [file]
  if (text.startsWith("/read ")) {
    const filePath = text.slice(6).trim();
    await sendMessage(chatId, `📖 Lecture de \`${filePath}\`...`);
    const file = await getFileContent(filePath);
    if (!file) {
      await sendMessage(chatId, `❌ Fichier \`${filePath}\` introuvable.`);
      return;
    }
    const preview = file.content.length > 3500 ? file.content.slice(0, 3500) + "\n...[tronqué]" : file.content;
    await sendMessage(chatId, `*\`${filePath}\` :*\n\`\`\`\n${preview}\n\`\`\``);
    return;
  }

  // /status
  if (text.startsWith("/status")) {
    const run = await getLastCommitStatus();
    if (!run) {
      await sendMessage(chatId, "ℹ️ Aucun déploiement GitHub Actions trouvé.");
      return;
    }
    const icon = run.status === "success" ? "✅" : run.status === "failure" ? "❌" : "⏳";
    await sendMessage(chatId, `${icon} *Dernier déploiement :*\nStatut: \`${run.status}\`\nCommit: \`${run.sha}\`\n[Voir les logs](${run.url})`);
    return;
  }

  // /deploy — redeploy Edge Function directly
  if (text.startsWith("/deploy")) {
    await sendMessage(chatId, "🚀 Redéploiement de l'Edge Function en cours...");
    const currentFile = await getFileContent("supabase/functions/telegram-agent/index.ts");
    if (!currentFile) {
      await sendMessage(chatId, "❌ Fichier source introuvable dans le repo.");
      return;
    }
    const result = await deployEdgeFunction(currentFile.content);
    if (result.ok) {
      await sendMessage(chatId, "✅ *Edge Function redéployée avec succès !*\nLe bot est à jour.");
    } else {
      // Auto-correct via Groq
      await sendMessage(chatId, "❌ Déploiement échoué. Analyse IA en cours...");
      const analysis = await callGroq([
        { role: "system", content: CORRECTION_PROMPT },
        { role: "user", content: `Logs d'erreur du déploiement Supabase:\n${result.error}` },
      ]);
      let parsed: { diagnostic: string; fix_suggestion: string } = { diagnostic: "Inconnu", fix_suggestion: "Vérifiez le code" };
      try { parsed = JSON.parse(analysis); } catch { /* ignore */ }
      await sendMessage(chatId,
        `❌ *Déploiement échoué*\n\n` +
        `🔍 *Diagnostic IA :* ${parsed.diagnostic}\n\n` +
        `💡 *Correction suggérée :* ${parsed.fix_suggestion}`
      );
    }
    return;
  }

  // Autonomous agent mode — natural language
  await sendMessage(chatId, "🧠 Analyse du projet en cours...");

  const files = await getRepoTree();
  if (files.length === 0) {
    await sendMessage(chatId, "❌ Repo vide ou inaccessible. Poussez d'abord du code sur GitHub.");
    return;
  }

  // Read key files for context
  const keyExtensions = [".ts", ".js", ".tsx", ".jsx", ".json", ".md", ".py", ".toml", ".yaml", ".yml", ".env.example"];
  const keyFiles = files
    .filter(f => keyExtensions.some(ext => f.path.endsWith(ext)) && !f.path.includes("pnpm-lock") && !f.path.includes(".tsbuildinfo"))
    .slice(0, 15);

  let contextFiles = "";
  for (const f of keyFiles) {
    const file = await getFileContent(f.path);
    if (file) {
      contextFiles += `\n\n--- FILE: ${f.path} ---\n${file.content.slice(0, 1500)}`;
    }
  }

  const treeStr = files.map(f => f.path).join("\n");

  await sendMessage(chatId, `📁 ${files.length} fichiers analysés, ${keyFiles.length} lus. IA en réflexion...`);
  await sendTyping(chatId);

  const aiResponse = await callGroq([
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `ARBORESCENCE DU PROJET:\n${treeStr}\n\nCONTENU DES FICHIERS CLÉS:${contextFiles}\n\nDEMANDE UTILISATEUR: ${text}`,
    },
  ]);

  let parsed: { explanation: string; files: { path: string; content: string; action: string }[] };
  try {
    parsed = JSON.parse(aiResponse);
  } catch {
    await sendMessage(chatId, `❌ Erreur de parsing JSON.\n\nRéponse brute:\n${aiResponse.slice(0, 500)}`);
    return;
  }

  if (!parsed.files || parsed.files.length === 0) {
    await sendMessage(chatId, `ℹ️ *Analyse de l'IA :*\n\n${parsed.explanation}`);
    return;
  }

  await sendMessage(chatId,
    `💡 *Plan de l'agent :*\n${parsed.explanation}\n\n` +
    `📝 Fichiers : ${parsed.files.map(f => `\`${f.path}\` (${f.action})`).join(", ")}\n\n` +
    `⏳ Application des modifications...`
  );

  await sendTyping(chatId);
  const results: string[] = [];

  for (const file of parsed.files) {
    try {
      if (file.action === "delete") {
        const existing = await getFileContent(file.path);
        if (existing) {
          const ok = await deleteFile(file.path, `[Editbot] Delete ${file.path}`, existing.sha);
          results.push(ok ? `🗑️ \`${file.path}\` supprimé` : `❌ Échec suppression \`${file.path}\``);
        } else {
          results.push(`⚠️ \`${file.path}\` déjà absent`);
        }
      } else {
        const existing = await getFileContent(file.path);
        const ok = await updateFile(
          file.path,
          file.content,
          `[Editbot] ${file.action === "create" ? "Create" : "Update"} ${file.path}`,
          existing?.sha
        );
        results.push(ok
          ? `✅ \`${file.path}\` ${file.action === "create" ? "créé" : "mis à jour"}`
          : `❌ Échec sur \`${file.path}\``
        );
      }
    } catch (e) {
      results.push(`❌ Erreur \`${file.path}\`: ${String(e).slice(0, 100)}`);
    }
  }

  const allOk = results.every(r => r.startsWith("✅") || r.startsWith("🗑️"));

  await sendMessage(chatId,
    `*Résultat :*\n${results.join("\n")}\n\n` +
    (allOk
      ? `✅ Modifications appliquées sur GitHub.\n💡 Tapez /deploy pour redéployer l'Edge Function.`
      : `⚠️ Certaines modifications ont échoué. Tapez /ls pour vérifier l'état du repo.`)
  );
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("OK", { status: 200 });
  try {
    const body: TelegramMessage = await req.json();
    const message = body.message;
    if (!message?.text) return new Response("OK", { status: 200 });
    const chatId = message.chat.id;
    const text = message.text.trim();
    handleCommand(chatId, text).catch(console.error);
    return new Response("OK", { status: 200 });
  } catch (e) {
    console.error(e);
    return new Response("Error", { status: 500 });
  }
});
