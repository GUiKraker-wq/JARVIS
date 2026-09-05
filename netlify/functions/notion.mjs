/**
 * Ponte com a API do Notion.
 *
 * A API do Notion não aceita chamadas direto do navegador (bloqueia CORS), por
 * isso toda conversa passa por aqui. O token fica na variável de ambiente
 * NOTION_TOKEN, configurada no painel do Netlify.
 *
 * GET  -> status (se o servidor tem token)
 * POST -> { action: "setup" | "export" | "import", ... }
 */

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const RICH_TEXT_LIMIT = 1900;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function codeIsValid(req) {
  const expected = process.env.ACCESS_CODE;
  if (!expected) return true;
  return req.headers.get("x-kraker-code") === expected;
}

/** Aceita tanto um ID cru quanto uma URL do Notion e devolve o UUID com hífens. */
function normalizeId(raw) {
  if (!raw) return null;
  const hex = String(raw).replace(/[^0-9a-fA-F]/g, "");
  // Uma URL do Notion termina com o ID de 32 caracteres.
  const id = hex.length >= 32 ? hex.slice(hex.length - 32) : hex;
  if (id.length !== 32) return null;
  return (
    id.slice(0, 8) + "-" + id.slice(8, 12) + "-" + id.slice(12, 16) + "-" +
    id.slice(16, 20) + "-" + id.slice(20)
  );
}

async function notion(path, token, method, body) {
  const res = await fetch(NOTION_API + path, {
    method: method || "GET",
    headers: {
      Authorization: "Bearer " + token,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || "O Notion respondeu com erro " + res.status);
    err.status = res.status;
    throw err;
  }
  return data;
}

function text(content) {
  return [{ type: "text", text: { content: String(content || "").slice(0, RICH_TEXT_LIMIT) } }];
}

/** Lê todas as linhas da base, paginando. */
async function queryAll(databaseId, token) {
  const rows = [];
  let cursor;
  do {
    const page = await notion("/databases/" + databaseId + "/query", token, "POST",
      cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 });
    rows.push(...(page.results || []));
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return rows;
}

/**
 * Descobre as colunas pelo TIPO e não pelo nome — assim a sincronização
 * continua funcionando mesmo se o nome da coluna for alterado no Notion.
 */
function readRow(page) {
  const props = page.properties || {};
  let title = "", area = "", body = "", noteId = null;
  for (const key of Object.keys(props)) {
    const p = props[key];
    if (p.type === "title") {
      title = (p.title || []).map((t) => t.plain_text).join("").trim();
    } else if (p.type === "select" && !area) {
      area = p.select ? p.select.name : "";
    } else if (p.type === "rich_text" && !body) {
      body = (p.rich_text || []).map((t) => t.plain_text).join("").trim();
    } else if (p.type === "number" && noteId === null) {
      noteId = p.number;
    }
  }
  return { pageId: page.id, title, area, body, noteId };
}

function propertyNames(database) {
  const props = database.properties || {};
  const found = { title: null, select: null, rich_text: null, number: null };
  for (const key of Object.keys(props)) {
    const type = props[key].type;
    if (found[type] === null && found.hasOwnProperty(type)) found[type] = key;
  }
  return found;
}

function buildProperties(names, note) {
  const out = {};
  if (names.title) out[names.title] = { title: text(note.title) };
  if (names.select) out[names.select] = { select: { name: String(note.area || "meta") } };
  if (names.rich_text) out[names.rich_text] = { rich_text: text(note.body) };
  if (names.number) out[names.number] = { number: Number(note.id) };
  return out;
}

const AREA_OPTIONS = [
  { name: "metas", color: "yellow" },
  { name: "trabalho", color: "red" },
  { name: "projetos", color: "purple" },
  { name: "financas", color: "orange" },
  { name: "aprendizado", color: "blue" },
  { name: "saude", color: "green" },
  { name: "relacoes", color: "pink" },
  { name: "meta", color: "gray" }
];

export default async (req) => {
  const token = process.env.NOTION_TOKEN;

  if (req.method === "GET") {
    return json({ ok: true, hasToken: !!token });
  }
  if (req.method !== "POST") {
    return json({ error: "Método não permitido." }, 405);
  }
  if (!token) {
    return json({
      code: "NO_NOTION_TOKEN",
      error: "NOTION_TOKEN não está configurado neste site."
    }, 503);
  }
  if (!codeIsValid(req)) {
    return json({ code: "BAD_CODE", error: "Código de acesso inválido." }, 401);
  }

  let payload;
  try {
    payload = await req.json();
  } catch (e) {
    return json({ error: "Corpo da requisição inválido." }, 400);
  }

  try {
    /* ---- cria a base de dados dentro de uma página existente ---- */
    if (payload.action === "setup") {
      const parentId = normalizeId(payload.parentPageId);
      if (!parentId) {
        return json({ error: "Cole o link (ou o ID) de uma página do Notion válida." }, 400);
      }
      const db = await notion("/databases", token, "POST", {
        parent: { type: "page_id", page_id: parentId },
        title: text("Kraker · Second Brain"),
        properties: {
          "Título": { title: {} },
          "Área": { select: { options: AREA_OPTIONS } },
          "Conteúdo": { rich_text: {} },
          "ID": { number: {} }
        }
      });
      return json({ ok: true, databaseId: db.id, url: db.url });
    }

    /* ---- envia as notas locais para a base ---- */
    if (payload.action === "export") {
      const databaseId = normalizeId(payload.databaseId);
      if (!databaseId) return json({ error: "ID da base inválido." }, 400);
      const notes = Array.isArray(payload.notes) ? payload.notes : [];

      const database = await notion("/databases/" + databaseId, token);
      const names = propertyNames(database);
      const existing = await queryAll(databaseId, token);

      const byNoteId = new Map();
      const byTitle = new Map();
      existing.forEach((page) => {
        const row = readRow(page);
        if (row.noteId !== null && row.noteId !== undefined) byNoteId.set(row.noteId, page.id);
        if (row.title) byTitle.set(row.title.toLowerCase(), page.id);
      });

      let created = 0, updated = 0;
      for (const note of notes) {
        const props = buildProperties(names, note);
        const target = byNoteId.get(Number(note.id)) || byTitle.get(String(note.title).toLowerCase());
        if (target) {
          await notion("/pages/" + target, token, "PATCH", { properties: props });
          updated++;
        } else {
          await notion("/pages", token, "POST", {
            parent: { database_id: databaseId },
            properties: props
          });
          created++;
        }
      }
      return json({ ok: true, created, updated, total: notes.length });
    }

    /* ---- lê as notas que estão na base ---- */
    if (payload.action === "import") {
      const databaseId = normalizeId(payload.databaseId);
      if (!databaseId) return json({ error: "ID da base inválido." }, 400);

      const rows = await queryAll(databaseId, token);
      const notes = rows
        .map(readRow)
        .filter((r) => r.title)
        .map((r) => ({
          id: r.noteId === null || r.noteId === undefined ? null : Number(r.noteId),
          area: r.area || "meta",
          title: r.title,
          body: r.body
        }));
      return json({ ok: true, notes: notes });
    }

    return json({ error: "Ação desconhecida." }, 400);
  } catch (e) {
    const status = e.status === 401 || e.status === 404 ? e.status : 502;
    return json({ error: e.message || "Falha ao falar com o Notion." }, status);
  }
};
