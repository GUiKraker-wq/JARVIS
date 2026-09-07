# Kraker · Assistente de voz pessoal

Assistente de voz estilo Jarvis com **Second Brain**: um grafo neural animado que
guarda o contexto da sua vida em notas e injeta esse contexto em toda resposta.

- Voz (fala e escuta) com a Web Speech API nativa do navegador
- Cérebro na API do Gemini (Google AI Studio, tem camada gratuita)
- Second Brain com memória viva: o assistente cria e atualiza notas sozinho
- **Agenda**: várias agendas do Google mescladas numa timeline única
- **E-mails**: caixa de entrada triada em AÇÃO · INFO · RUÍDO
- **Notícias**: manchetes por tópico, via Google News
- **Morning Digest**: briefing falado do dia (agenda + e-mails + notícias + clima)
- Sincronização opcional com o Notion

## Estrutura

```
index.html                      o app inteiro (HTML + CSS + JS, sem bibliotecas)
netlify.toml                    configuração do deploy
netlify/functions/gemini.mjs    proxy da API do Gemini (guarda a chave)
netlify/functions/calendar.mjs  busca os .ics das agendas (o navegador não pode)
netlify/functions/emails.mjs    cliente IMAP em Node puro, somente leitura
netlify/functions/news.mjs      RSS do Google News, todos os tópicos em paralelo
netlify/functions/notion.mjs    ponte com a API do Notion
```

## Rodando local

Basta abrir `index.html` no Chrome. Nesse modo não existe servidor, então a chave
do Gemini precisa ser colada em **⚙ Configurações** (fica salva só no seu
navegador). A sincronização com o Notion não funciona sem o site publicado.

## Publicando no Netlify

1. Conecte este repositório no Netlify (ou arraste a pasta em app.netlify.com/drop).
   Não há build: o `netlify.toml` já aponta a raiz como pasta publicada.
2. Em **Site configuration → Environment variables**, crie:

   | Variável | Obrigatória | Para que serve |
   |---|---|---|
   | `GEMINI_API_KEY` | sim | chave grátis do Google AI Studio |
   | `ACCESS_CODE` | recomendada | senha simples que libera o uso do site |
   | `GMAIL_USER` | só p/ e-mails | o endereço da conta a ser lida |
   | `GMAIL_APP_PASSWORD` | só p/ e-mails | senha de app de 16 letras (não é a senha normal) |
   | `NOTION_TOKEN` | só p/ Notion | token da sua integração do Notion (`ntn_...`) |

   A chave do Gemini se cria de graça em <https://aistudio.google.com/apikey>
   (login com conta Google). O modelo padrão é `gemini-flash-latest` — um
   "apelido" que o Google sempre aponta pro Flash mais atual, então não quebra
   quando uma versão específica (tipo `gemini-2.5-flash`) é descontinuada. Pra
   trocar de modelo, edite `CONFIG.model` no topo do `<script>` dentro de
   `index.html`.

3. Publique. O app detecta sozinho que existe chave no servidor e mostra
   **🔒 chave no servidor** no topo.

### Por que a chave fica em variável de ambiente

Um site no Netlify é público: qualquer pessoa consegue ler o HTML e ver o tráfego
do navegador. Uma chave escrita dentro do `index.html` seria visível para todos, e
qualquer um poderia gastar os seus créditos. Com o proxy, a chave só existe no
servidor da função e nunca chega ao navegador.

O endpoint da função continua público, então vale definir `ACCESS_CODE`: com ele
configurado, só quem digitar o código em ⚙ Configurações consegue usar o cérebro.
A função também limita `max_tokens` e o tamanho do histórico.

## Notion

1. Crie uma integração em <https://www.notion.so/my-integrations> e copie o token.
2. Salve o token como `NOTION_TOKEN` no Netlify.
3. No Notion, abra a página que vai abrigar a base e compartilhe ela com a sua
   integração (menu `...` → **Connections** → escolha a integração).
4. No app, clique em **◈**, cole o link dessa página e clique em
   **Criar base no Notion**. O ID da base fica salvo no navegador.
5. Depois é só usar **Enviar pro Notion** e **Importar do Notion**.

A fusão é feita por título: nota com o mesmo título é atualizada, título novo vira
uma nota nova. Se preferir algo manual, **Copiar tudo em Markdown** joga o Second
Brain inteiro no clipboard, pronto pra colar numa página do Notion.

## Agenda

Cada agenda do Google tem um link privado de leitura em formato iCal — sem senha e
sem configurar nada no Google Cloud. No computador: **Google Agenda → ⚙ Configurações
→ clique na agenda na lista à esquerda → Integrar agenda → Endereço secreto em formato
iCal**. Cole no painel ⚙ do Kraker (botão "+ adicionar agenda").

Esses links ficam só no navegador (`jarvis_calendars`) e nunca são enviados à IA. O
parser de ICS cobre TZID, UTC, eventos de dia inteiro, recorrência (RRULE com
DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, BYDAY, COUNT, UNTIL) e EXDATE. Uma agenda com
link inválido mostra o erro dela sem derrubar as outras.

## E-mails

A senha de app vive só no servidor, nas variáveis acima. Para gerá-la, **nesta ordem**:

1. Ative a verificação em 2 etapas em <https://myaccount.google.com/security> — sem
   ela o Google nem mostra a opção de senha de app.
2. Em <https://myaccount.google.com/apppasswords>, crie um app chamado "Kraker".
3. Copie a senha de 16 letras e salve como `GMAIL_APP_PASSWORD` no Netlify.

A leitura usa `EXAMINE` (somente leitura) e `BODY.PEEK` — **nenhum e-mail é marcado
como lido**, e o Kraker nunca envia, responde ou apaga nada. Na triagem, remetente,
assunto e um trecho vão para a API do Gemini numa única chamada por lote; cada
Message-ID triado fica em cache e nunca volta para a IA. Sem chave, a triagem cai
para uma heurística local.

## Economia

Nada é buscado em segundo plano: agenda, e-mails e notícias só atualizam quando você
clica em ↻ ou pede por voz. Os comandos locais ("minha agenda", "meus e-mails",
"notícias"…) são respondidos sem tocar na API. O digest roda uma vez por dia.

## Backup

Os botões **⬇** e **⬆** no painel do Second Brain baixam e recarregam um JSON com
todas as notas e as ligações do grafo.
