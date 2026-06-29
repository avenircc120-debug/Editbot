import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const TELEGRAM_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY")!;
const GITHUB_TOKEN = Deno.env.get("GITHUB_ACCESS_TOKEN")!;
const GITHUB_REPO = Deno.env.get("GITHUB_REPO")!;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const SYSTEM_PROMPT = `Tu es Editbot, un agent de développement autonome et omniscient.

Ton rôle :
- Analyser l'arborescence complète d'un projet GitHub
- Comprendre les dépendances entre fichiers
- Modifier le code de façon intelligente et cohérente selon les intentions naturelles de l'utilisateur
- Garantir que chaque modification est syntaxiquement correcte et fonctionnellement cohérente

Règles absolues :
1. Tu dois toujours retourner un JSON valide avec la structure suivante :
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
2. Retourne TOUJOURS le fichier COMPLET, jamais de extraits partiels
3. Sois précis sur les chemins de fichiers (respecte la casse)
4. Si tu crées plusieurs fichiers interdépendants, inclus-les tous dans la même réponse
5. Ne jamais inclure de commentaires hors du JSON`;

interface TelegramMessage {
  message?: {
    chat: { id: number };
    text?: string;
    from?: { id: number; username?: string };
  };
}

interface GitHubFile {
  path: string;
  type: string;
  sha: string;
  size?: number;
  url: string;
}

interface SessionState {
  activeFiles: string[];
  lastCommand: string;
  projectTree: string;
}

const sessions = new Map<number, SessionState>();

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

async function getRepoTree(path = ""): Promise<GitHubFile[]> {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) return [];
  const items: GitHubFile[] = await res.json();
  let allFiles: GitHubFile[] = [];
  for (const item of items) {
    if (item.type === "dir") {
      const subFiles = await getRepoTree(item.path);
      allFiles = allFiles.concat(subFiles);
    } else {
      allFiles.push(item);
    }
  }
  return allFiles;
}

async function getFileContent(path: string): Promise<{ content: string; sha: string } | null> {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`,
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
    }
  );
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

  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  return res.ok;
}

async function deleteFile(path: string, message: string, sha: string): Promise<boolean> {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, sha }),
    }
  );
  return res.ok;
}

async function callGroq(messages: { role: string; content: string }[]): Promise<string> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama3-70b-8192",
      messages,
      temperature: 0.2,
      max_tokens: 8192,
      response_format: { type: "json_object" },
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "{}";
}

async function handleCommand(chatId: number, text: string) {
  const session = sessions.get(chatId) ?? { activeFiles: [], lastCommand: "", projectTree: "" };

  if (text.startsWith("/start")) {
    await sendMessage(chatId,
      `🤖 *Editbot — Agent IA de développement autonome*\n\n` +
      `Je scanne votre projet GitHub et modifie le code selon vos intentions.\n\n` +
      `*Commandes disponibles :*\n` +
      `/ls — Lister tous les fichiers du projet\n` +
      `/read [fichier] — Lire un fichier spécifique\n` +
      `/status — Statut du dernier déploiement\n\n` +
      `Ou décrivez simplement ce que vous voulez faire !`
    );
    return;
  }

  if (text.startsWith("/ls")) {
    await sendMessage(chatId, "🔍 Scan de l'arborescence en cours...");
    const files = await getRepoTree();
    if (files.length === 0) {
      await sendMessage(chatId, "❌ Impossible de lire le repo. Vérifiez GITHUB_REPO.");
      return;
    }
    const tree = files.map(f => `📄 \`${f.path}\``).join("\n");
    session.projectTree = files.map(f => f.path).join("\n");
    sessions.set(chatId, session);
    await sendMessage(chatId, `*Arborescence du projet (${files.length} fichiers) :*\n\n${tree}`);
    return;
  }

  if (text.startsWith("/read ")) {
    const filePath = text.replace("/read ", "").trim();
    await sendMessage(chatId, `📖 Lecture de \`${filePath}\`...`);
    const file = await getFileContent(filePath);
    if (!file) {
      await sendMessage(chatId, `❌ Fichier \`${filePath}\` introuvable.`);
      return;
    }
    await sendMessage(chatId, `*Contenu de \`${filePath}\` :*\n\`\`\`\n${file.content.slice(0, 3500)}\n\`\`\``);
    return;
  }

  if (text.startsWith("/status")) {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/actions/runs?per_page=1`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
        },
      }
    );
    const data = await res.json();
    const run = data.workflow_runs?.[0];
    if (!run) {
      await sendMessage(chatId, "ℹ️ Aucun déploiement trouvé.");
      return;
    }
    const icon = run.conclusion === "success" ? "✅" : run.conclusion === "failure" ? "❌" : "⏳";
    await sendMessage(chatId,
      `${icon} *Dernier déploiement :*\n` +
      `Status: \`${run.conclusion ?? run.status}\`\n` +
      `Branche: \`${run.head_branch}\`\n` +
      `Commit: \`${run.head_sha?.slice(0, 7)}\`\n` +
      `[Voir les logs](${run.html_url})`
    );
    return;
  }

  // Autonomous agent mode
  await sendMessage(chatId, "🧠 Analyse du projet en cours...");

  const files = await getRepoTree();
  if (files.length === 0) {
    await sendMessage(chatId, "❌ Repo vide ou inaccessible. Poussez d'abord du code.");
    return;
  }

  // Read key files for context (limit to avoid token overflow)
  const keyExtensions = [".ts", ".js", ".tsx", ".jsx", ".json", ".md", ".py", ".env.example"];
  const keyFiles = files
    .filter(f => keyExtensions.some(ext => f.path.endsWith(ext)))
    .slice(0, 15);

  let contextFiles = "";
  for (const f of keyFiles) {
    const file = await getFileContent(f.path);
    if (file) {
      contextFiles += `\n\n--- FILE: ${f.path} ---\n${file.content.slice(0, 1500)}`;
    }
  }

  const treeStr = files.map(f => f.path).join("\n");
  session.projectTree = treeStr;
  sessions.set(chatId, session);

  await sendMessage(chatId, `📁 ${files.length} fichiers analysés. IA en réflexion...`);

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
    await sendMessage(chatId, `❌ L'IA n'a pas retourné un JSON valide.\n\n${aiResponse.slice(0, 500)}`);
    return;
  }

  if (!parsed.files || parsed.files.length === 0) {
    await sendMessage(chatId, `ℹ️ *Analyse de l'IA :*\n\n${parsed.explanation}`);
    return;
  }

  await sendMessage(chatId,
    `💡 *Plan de l'agent :*\n${parsed.explanation}\n\n` +
    `📝 Fichiers à modifier : ${parsed.files.map(f => `\`${f.path}\``).join(", ")}\n\n` +
    `⏳ Application des modifications...`
  );

  const results: string[] = [];
  for (const file of parsed.files) {
    try {
      if (file.action === "delete") {
        const existing = await getFileContent(file.path);
        if (existing) {
          const ok = await deleteFile(file.path, `[Editbot] Delete ${file.path}`, existing.sha);
          results.push(ok ? `🗑️ \`${file.path}\` supprimé` : `❌ Échec suppression \`${file.path}\``);
        }
      } else {
        const existing = await getFileContent(file.path);
        const ok = await updateFile(
          file.path,
          file.content,
          `[Editbot] ${file.action === "create" ? "Create" : "Update"} ${file.path}`,
          existing?.sha
        );
        results.push(ok ? `✅ \`${file.path}\` ${file.action === "create" ? "créé" : "mis à jour"}` : `❌ Échec \`${file.path}\``);
      }
    } catch (e) {
      results.push(`❌ Erreur sur \`${file.path}\`: ${e}`);
    }
  }

  await sendMessage(chatId,
    `*Résultat des modifications :*\n${results.join("\n")}\n\n` +
    `🚀 GitHub Actions va maintenant déclencher le déploiement automatiquement.\n` +
    `Utilisez /status pour suivre le déploiement.`
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
