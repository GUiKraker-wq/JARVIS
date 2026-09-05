/**
 * Proxy da API da Anthropic.
 *
 * A chave NUNCA vai para o navegador: ela fica na variável de ambiente
 * ANTHROPIC_API_KEY, configurada no painel do Netlify.
 *
 * GET  -> devolve o status (se o servidor tem chave e se exige código de acesso)
 * POST -> repassa a chamada para https://api.anthropic.com/v1/messages
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS_CAP = 1024;
const MAX_MESSAGES = 40;

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

export default async (req) => {
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  const needsCode = !!process.env.ACCESS_CODE;

  if (req.method === "GET") {
    return json({ ok: true, hasKey, needsCode });
  }

  if (req.method !== "POST") {
    return json({ error: "Método não permitido." }, 405);
  }

  if (!hasKey) {
    return json({
      code: "NO_SERVER_KEY",
      error: "ANTHROPIC_API_KEY não está configurada neste site."
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

  if (!payload || typeof payload.model !== "string" || !payload.model.startsWith("claude-")) {
    return json({ error: "Modelo inválido." }, 400);
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return json({ error: "Histórico de mensagens ausente." }, 400);
  }

  // Limites de segurança: o endpoint é público, então nada de gerações gigantes.
  payload.max_tokens = Math.min(Number(payload.max_tokens) || 400, MAX_TOKENS_CAP);
  payload.messages = payload.messages.slice(-MAX_MESSAGES);

  try {
    const upstream = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  } catch (e) {
    return json({ error: "Não foi possível contatar a API da Anthropic." }, 502);
  }
};
