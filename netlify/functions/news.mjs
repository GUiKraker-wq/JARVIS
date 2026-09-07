/**
 * Antena das NOTÍCIAS.
 *
 * Busca o RSS do Google News de vários tópicos DE UMA VEZ (em paralelo) e
 * devolve JSON já limpo. Um clique no ↻ = uma invocação de função, não uma
 * por tópico — é o que segura o consumo de créditos.
 *
 * Fonte gratuita, sem chave, sem limite prático.
 */

const NEWS_HOST = "news.google.com";
const MAX_TOPICS = 10;
const MAX_ITEMS = 10;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

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

function decodeEntities(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/<[^>]*>/g, "")
    .trim();
}

function pick(block, tag) {
  const m = block.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "i"));
  return m ? decodeEntities(m[1]) : "";
}

/**
 * O Google News carimba " - Fonte" no fim de cada título. Guardamos o título
 * limpo (pra fala ficar natural) e a fonte separada.
 */
function splitTitle(title, sourceName) {
  if (sourceName && title.endsWith(" - " + sourceName)) {
    return title.slice(0, -(sourceName.length + 3)).trim();
  }
  const dash = title.lastIndexOf(" - ");
  if (dash > 20) return title.slice(0, dash).trim();
  return title;
}

function parseRss(xml, limit) {
  const items = [];
  const blocks = xml.split(/<item>/i).slice(1);
  for (const raw of blocks) {
    const block = raw.split(/<\/item>/i)[0];
    const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
    const source = sourceMatch ? decodeEntities(sourceMatch[1]) : "";
    const title = pick(block, "title");
    if (!title) continue;
    items.push({
      title: splitTitle(title, source),
      source: source,
      link: pick(block, "link"),
      pubDate: pick(block, "pubDate")
    });
    if (items.length >= limit) break;
  }
  return items;
}

async function fetchTopic(topic, count, hl, gl, ceid) {
  const url = "https://" + NEWS_HOST + "/rss/search?q=" +
    encodeURIComponent(topic.query || topic.label) +
    "&hl=" + encodeURIComponent(hl) +
    "&gl=" + encodeURIComponent(gl) +
    "&ceid=" + encodeURIComponent(ceid);

  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/rss+xml, text/xml, */*" } });
  if (!res.ok) throw new Error("Google News respondeu " + res.status);
  const xml = await res.text();
  return parseRss(xml, count);
}

export default async (req) => {
  if (req.method === "GET") {
    return json({ ok: true, ready: true });
  }
  if (req.method !== "POST") {
    return json({ error: "Método não permitido." }, 405);
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

  const topics = Array.isArray(payload.topics) ? payload.topics.slice(0, MAX_TOPICS) : [];
  if (topics.length === 0) {
    return json({ error: "Nenhum tópico configurado." }, 400);
  }
  const count = Math.min(Math.max(Number(payload.count) || 5, 1), MAX_ITEMS);
  const hl = String(payload.hl || "pt-BR");
  const gl = String(payload.gl || "BR");
  const ceid = String(payload.ceid || "BR:pt-419");

  const results = await Promise.all(topics.map(async (topic) => {
    try {
      const items = await fetchTopic(topic, count, hl, gl, ceid);
      return { label: topic.label, ok: true, items };
    } catch (e) {
      console.error("Falha no tópico", topic.label, "-", e.message);
      return { label: topic.label, ok: false, error: e.message, items: [] };
    }
  }));

  return json({ ok: true, fetchedAt: Date.now(), results });
};
