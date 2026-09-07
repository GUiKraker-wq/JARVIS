/**
 * Antena da AGENDA.
 *
 * O navegador não consegue buscar um .ics do Google direto (CORS), então esta
 * função busca por ele. Recebe os "endereços secretos em formato iCal" e
 * devolve o texto cru — quem interpreta o ICS é o próprio Kraker, no navegador.
 *
 * Os links são segredos: nunca aparecem em log.
 */

const ALLOWED_HOSTS = ["calendar.google.com"];
const MAX_REDIRECTS = 3;
const MAX_URLS = 12;
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

function hostAllowed(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:") return false;
    return ALLOWED_HOSTS.includes(u.hostname);
  } catch (e) {
    return false;
  }
}

/** Segue redirects manualmente, revalidando a allowlist a cada salto. */
async function fetchIcs(url, hops) {
  if (hops > MAX_REDIRECTS) throw new Error("Redirecionamentos demais.");
  if (!hostAllowed(url)) throw new Error("Endereço fora da lista permitida.");

  const res = await fetch(url, {
    redirect: "manual",
    headers: { "user-agent": UA, accept: "text/calendar, text/plain, */*" }
  });

  if (res.status >= 300 && res.status < 400) {
    const next = res.headers.get("location");
    if (!next) throw new Error("Redirecionamento sem destino.");
    return fetchIcs(new URL(next, url).toString(), hops + 1);
  }
  if (res.status === 404) {
    throw new Error("Link não encontrado — confira se copiou o endereço secreto completo.");
  }
  if (!res.ok) {
    throw new Error("O Google respondeu com erro " + res.status + ".");
  }

  const text = await res.text();
  if (text.indexOf("BEGIN:VCALENDAR") === -1) {
    throw new Error("O link não devolveu um calendário válido.");
  }
  return text;
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

  const urls = Array.isArray(payload.urls) ? payload.urls.slice(0, MAX_URLS) : [];
  if (urls.length === 0) {
    return json({ error: "Nenhuma agenda configurada." }, 400);
  }

  // Todas as agendas em paralelo: 1 invocação da função busca o conjunto todo.
  const results = await Promise.all(urls.map(async (url, index) => {
    try {
      const ics = await fetchIcs(String(url), 0);
      return { index, ok: true, ics };
    } catch (e) {
      // Uma agenda quebrada não pode derrubar as outras.
      console.error("Falha ao buscar agenda no índice", index, "-", e.message);
      return { index, ok: false, error: e.message };
    }
  }));

  return json({ ok: true, results });
};
