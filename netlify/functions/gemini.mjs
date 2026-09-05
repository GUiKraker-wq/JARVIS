/**
 * Proxy da API do Gemini (Google AI Studio).
 *
 * A chave NUNCA vai para o navegador: ela fica na variável de ambiente
 * GEMINI_API_KEY, configurada no painel do Netlify. Uma chave grátis se
 * cria em https://aistudio.google.com/apikey.
 *
 * GET  -> devolve o status (se o servidor tem chave e se exige código de acesso)
 * POST -> recebe { model, max_tokens, system, messages } no formato genérico
 *         usado pelo app, traduz pro formato do Gemini e repassa.
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
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

/** { model, max_tokens, system, messages:[{role,content}] } -> corpo do Gemini. */
function toGeminiBody(payload) {
  return {
    contents: payload.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content || "") }]
    })),
    systemInstruction: { parts: [{ text: String(payload.system || "") }] },
    generationConfig: { maxOutputTokens: payload.max_tokens }
  };
}

export default async (req) => {
  const hasKey = !!process.env.GEMINI_API_KEY;
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
      error: "GEMINI_API_KEY não está configurada neste site."
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

  if (!payload || typeof payload.model !== "string" || !payload.model.startsWith("gemini-")) {
    return json({ error: "Modelo inválido." }, 400);
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return json({ error: "Histórico de mensagens ausente." }, 400);
  }

  // Limites de segurança: o endpoint é público, então nada de gerações gigantes.
  payload.max_tokens = Math.min(Number(payload.max_tokens) || 400, MAX_TOKENS_CAP);
  payload.messages = payload.messages.slice(-MAX_MESSAGES);

  const url = GEMINI_BASE + encodeURIComponent(payload.model) +
    ":generateContent?key=" + process.env.GEMINI_API_KEY;

  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toGeminiBody(payload))
    });
    const raw = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return json({
        error: (raw.error && raw.error.message) || "O Gemini respondeu com erro."
      }, upstream.status);
    }
    const candidate = raw.candidates && raw.candidates[0];
    const parts = candidate && candidate.content && candidate.content.parts;
    const text = Array.isArray(parts) ? parts.map((p) => p.text || "").join("") : "";
    return json({ content: [{ type: "text", text }] });
  } catch (e) {
    return json({ error: "Não foi possível contatar a API do Gemini." }, 502);
  }
};
