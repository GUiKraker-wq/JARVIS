/**
 * Antena dos E-MAILS.
 *
 * Cliente IMAP mínimo escrito com o módulo nativo `tls` — zero dependências.
 * Lê os N e-mails mais recentes da caixa de entrada e devolve JSON.
 *
 * Duas garantias que valem repetir:
 *  - EXAMINE (não SELECT) abre a caixa em modo SOMENTE LEITURA;
 *  - BODY.PEEK nunca marca e-mail como lido. A caixa fica intocada.
 *
 * As credenciais vivem em variáveis de ambiente (GMAIL_USER / GMAIL_APP_PASSWORD),
 * nunca no navegador e nunca em log.
 */

import tls from "node:tls";

const ALLOWED_IMAP_HOSTS = ["imap.gmail.com"];
const DEFAULT_HOST = "imap.gmail.com";
const IMAP_PORT = 993;
const MAX_COUNT = 40;
const BODY_OCTETS = 1500;
const SNIPPET_CHARS = 500;
const HARD_TIMEOUT_MS = 9000;

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

function maskUser(user) {
  if (!user) return "";
  const at = user.indexOf("@");
  if (at < 1) return "***";
  return user[0] + "***" + user.slice(at);
}

/* ─────────────── decodificação MIME ─────────────── */

function charsetOf(name) {
  const c = String(name || "").toLowerCase();
  if (c.indexOf("utf-8") !== -1 || c.indexOf("utf8") !== -1) return "utf8";
  if (c.indexOf("8859-1") !== -1 || c.indexOf("1252") !== -1) return "latin1";
  return "utf8";
}

/** Decodifica "=?UTF-8?B?...?=" e "=?UTF-8?Q?...?=" (assunto/remetente). */
function decodeMime(str) {
  if (!str) return "";
  // Palavras codificadas adjacentes: o espaço entre elas não faz parte do texto.
  const joined = String(str).replace(/\?=\s+=\?/g, "?==?");
  return joined.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (full, charset, enc, data) => {
    try {
      if (enc.toUpperCase() === "B") {
        return Buffer.from(data, "base64").toString(charsetOf(charset));
      }
      const bytes = data
        .replace(/_/g, " ")
        .replace(/=([0-9A-Fa-f]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
      return Buffer.from(bytes, "latin1").toString(charsetOf(charset));
    } catch (e) {
      return full;
    }
  }).trim();
}

function decodeQuotedPrintable(text, charset) {
  const bytes = String(text)
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(bytes, "latin1").toString(charsetOf(charset));
}

function stripHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * BODY[TEXT] devolve o corpo cru — que em mensagem multipart vem com
 * fronteiras e sub-cabeçalhos. Pega a melhor parte de texto disponível.
 * Tudo em best-effort: e-mail estranho vira trecho curto, nunca uma exceção.
 */
function extractSnippet(raw) {
  try {
    let best = null;
    const segments = String(raw).split(/\r?\n--[^\r\n]+\r?\n/);

    for (const seg of segments) {
      const split = seg.search(/\r?\n\r?\n/);
      if (split === -1) continue;
      const head = seg.slice(0, split);
      if (!/content-type:/i.test(head)) continue;

      const isPlain = /content-type:\s*text\/plain/i.test(head);
      const isHtml = /content-type:\s*text\/html/i.test(head);
      if (!isPlain && !isHtml) continue;
      if (best && best.isPlain && !isPlain) continue;

      const charsetMatch = head.match(/charset="?([\w-]+)"?/i);
      const cteMatch = head.match(/content-transfer-encoding:\s*([\w-]+)/i);
      const charset = charsetMatch ? charsetMatch[1] : "utf-8";
      const cte = cteMatch ? cteMatch[1].toLowerCase() : "7bit";

      let body = seg.slice(split).replace(/^\r?\n\r?\n/, "");
      if (cte === "base64") {
        body = Buffer.from(body.replace(/\s/g, ""), "base64").toString(charsetOf(charset));
      } else if (cte === "quoted-printable") {
        body = decodeQuotedPrintable(body, charset);
      }
      if (isHtml) body = stripHtml(body);

      best = { isPlain, body };
      if (isPlain) break;
    }

    let text = best ? best.body : String(raw);

    // Mensagem simples (sem multipart) pode vir inteira em base64/QP.
    if (!best) {
      if (/^[A-Za-z0-9+/=\s]+$/.test(text) && text.replace(/\s/g, "").length > 40) {
        try { text = Buffer.from(text.replace(/\s/g, ""), "base64").toString("utf8"); } catch (e) { /* segue cru */ }
      } else if (/=[0-9A-Fa-f]{2}/.test(text)) {
        text = decodeQuotedPrintable(text, "utf-8");
      }
      if (/<[a-z][\s\S]*>/i.test(text)) text = stripHtml(text);
    }

    return text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS);
  } catch (e) {
    return "";
  }
}

/* ─────────────── protocolo IMAP ─────────────── */

/**
 * Uma resposta IMAP termina na linha com a tag do comando — mas literais
 * ({123} seguido de 123 octetos) podem conter qualquer coisa, inclusive algo
 * parecido com essa linha. Por isso o scanner pula literais explicitamente.
 */
function responseComplete(text, tag) {
  let i = 0;
  while (i < text.length) {
    const nl = text.indexOf("\r\n", i);
    if (nl === -1) return false;
    const line = text.slice(i, nl);
    const literal = line.match(/\{(\d+)\}$/);
    if (literal) {
      i = nl + 2 + Number(literal[1]);
      if (i > text.length) return false;
      continue;
    }
    if (line.indexOf(tag + " ") === 0) return true;
    i = nl + 2;
  }
  return false;
}

function taggedLine(text, tag) {
  const lines = text.split("\r\n");
  for (const line of lines) {
    if (line.indexOf(tag + " ") === 0) return line.slice(tag.length + 1);
  }
  return "";
}

function makeClient(socket) {
  let buffer = Buffer.alloc(0);
  let waiter = null;

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (waiter) waiter.check();
  });

  function waitFor(predicate) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const text = buffer.toString("latin1");
        if (predicate(text)) {
          const done = buffer;
          buffer = Buffer.alloc(0);
          waiter = null;
          resolve(done);
        }
      };
      waiter = { check, reject };
      check();
    });
  }

  let counter = 0;
  async function send(command) {
    const tag = "a" + (++counter);
    socket.write(tag + " " + command + "\r\n");
    const raw = await waitFor((text) => responseComplete(text, tag));
    const result = taggedLine(raw.toString("latin1"), tag);
    if (result.indexOf("OK") !== 0) {
      const err = new Error(result || "Comando IMAP recusado.");
      err.imap = result;
      throw err;
    }
    return raw;
  }

  return {
    greeting: () => waitFor((text) => /^\* (OK|NO|BAD)/.test(text) && text.indexOf("\r\n") !== -1),
    send,
    fail: (e) => { if (waiter) waiter.reject(e); }
  };
}

/** Extrai, por mensagem, os atributos em texto e os literais em bytes. */
function parseFetch(raw) {
  const text = raw.toString("latin1");
  const out = new Map();
  const header = /\* (\d+) FETCH \(/g;
  let match;

  while ((match = header.exec(text)) !== null) {
    const seq = Number(match[1]);
    let i = match.index + match[0].length;
    let depth = 1;
    let attrs = "";
    const literals = [];

    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === "{") {
        const close = text.indexOf("}", i);
        if (close !== -1 && text.slice(close + 1, close + 3) === "\r\n") {
          const len = Number(text.slice(i + 1, close));
          const start = close + 3;
          literals.push(raw.slice(start, start + len));
          i = start + len;
          continue;
        }
      }
      if (ch === '"') {
        let j = i + 1;
        while (j < text.length && text[j] !== '"') {
          if (text[j] === "\\") j++;
          j++;
        }
        attrs += text.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) { i++; break; }
      }
      attrs += ch;
      i++;
    }

    out.set(seq, { attrs, literals });
    header.lastIndex = i;
  }
  return out;
}

function parseHeaders(text) {
  const unfolded = String(text).replace(/\r?\n[ \t]+/g, " ");
  const fields = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    fields[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return fields;
}

function prettyFrom(rawFrom) {
  const decoded = decodeMime(rawFrom);
  const withName = decoded.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (withName && withName[1].trim()) {
    return { name: withName[1].trim(), address: withName[2].trim() };
  }
  const bare = decoded.match(/<([^>]+)>/);
  const address = bare ? bare[1].trim() : decoded.trim();
  return { name: address.split("@")[0], address };
}

async function fetchInbox(host, user, password, count) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try { socket.end(); } catch (e) { /* já fechado */ }
      fn(value);
    };

    const socket = tls.connect({ host, port: IMAP_PORT, servername: host });
    socket.setTimeout(HARD_TIMEOUT_MS);
    socket.on("timeout", () => finish(reject, new Error("O servidor de e-mail demorou demais para responder.")));
    socket.on("error", (e) => finish(reject, new Error("Falha de conexão com o servidor de e-mail.")));

    const client = makeClient(socket);

    socket.on("secureConnect", async () => {
      try {
        await client.greeting();

        // Aspas escapadas: senha de app é alfanumérica, mas o usuário não é confiável.
        const esc = (s) => '"' + String(s).replace(/([\\"])/g, "\\$1") + '"';
        await client.send("LOGIN " + esc(user) + " " + esc(password));

        // EXAMINE = somente leitura. A caixa não é alterada de forma alguma.
        const examine = await client.send("EXAMINE INBOX");
        const existsMatch = examine.toString("latin1").match(/\* (\d+) EXISTS/);
        const exists = existsMatch ? Number(existsMatch[1]) : 0;

        if (exists === 0) {
          return finish(resolve, []);
        }

        const first = Math.max(1, exists - count + 1);
        const range = first + ":" + exists;

        // Dois FETCH separados: cada resposta traz um literal por mensagem,
        // o que torna o parsing bem mais previsível.
        const headRaw = await client.send(
          "FETCH " + range + " (FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)])"
        );
        const bodyRaw = await client.send(
          "FETCH " + range + " (BODY.PEEK[TEXT]<0." + BODY_OCTETS + ">)"
        );

        const heads = parseFetch(headRaw);
        const bodies = parseFetch(bodyRaw);

        const messages = [];
        for (const [seq, entry] of heads) {
          const headerText = entry.literals[0] ? entry.literals[0].toString("utf8") : "";
          const fields = parseHeaders(headerText);
          const bodyEntry = bodies.get(seq);
          const bodyText = bodyEntry && bodyEntry.literals[0] ? bodyEntry.literals[0].toString("utf8") : "";
          const from = prettyFrom(fields.from || "");

          messages.push({
            id: (fields["message-id"] || ("seq-" + seq)).replace(/[<>]/g, "").trim(),
            seq,
            from: from.name,
            fromAddress: from.address,
            subject: decodeMime(fields.subject || "(sem assunto)"),
            date: fields.date || "",
            snippet: extractSnippet(bodyText),
            unread: entry.attrs.indexOf("\\Seen") === -1
          });
        }

        messages.sort((a, b) => b.seq - a.seq);
        await client.send("LOGOUT").catch(() => {});
        finish(resolve, messages);
      } catch (e) {
        finish(reject, e);
      }
    });
  });
}

/* ─────────────── handler ─────────────── */

export default async (req) => {
  const user = process.env.GMAIL_USER;
  const password = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s/g, "");
  const host = process.env.IMAP_HOST || DEFAULT_HOST;

  if (req.method === "GET") {
    return json({
      ok: true,
      configured: !!(user && password),
      account: maskUser(user),
      host
    });
  }
  if (req.method !== "POST") {
    return json({ error: "Método não permitido." }, 405);
  }
  if (!codeIsValid(req)) {
    return json({ code: "BAD_CODE", error: "Código de acesso inválido." }, 401);
  }
  if (!user || !password) {
    return json({
      code: "NO_MAIL_CONFIG",
      error: "Conta de e-mail não configurada. Defina GMAIL_USER e GMAIL_APP_PASSWORD no Netlify."
    }, 503);
  }
  if (ALLOWED_IMAP_HOSTS.indexOf(host) === -1) {
    return json({ error: "Servidor IMAP fora da lista permitida." }, 403);
  }

  let payload = {};
  try {
    payload = await req.json();
  } catch (e) {
    payload = {};
  }
  const count = Math.min(Math.max(Number(payload.count) || 20, 1), MAX_COUNT);

  try {
    const messages = await fetchInbox(host, user, password, count);
    return json({ ok: true, account: maskUser(user), fetchedAt: Date.now(), messages });
  } catch (e) {
    // A mensagem do IMAP pode citar a conta; nunca devolvemos credencial.
    const detail = String(e.imap || e.message || "");
    const authFailed = /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(detail);
    console.error("Falha ao ler e-mails:", authFailed ? "credenciais recusadas" : detail.slice(0, 120));
    return json({
      code: authFailed ? "AUTH_FAILED" : "MAIL_ERROR",
      error: authFailed
        ? "Senha de app recusada. Refaça em myaccount.google.com/apppasswords (precisa da verificação em 2 etapas ativa)."
        : "Não consegui ler a caixa de entrada agora."
    }, authFailed ? 401 : 502);
  }
};
