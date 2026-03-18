# Aviator Bot

Servidor Node.js com Puppeteer + Express para:

- fazer login automático no `megagamelive.com`;
- abrir o jogo Aviator;
- capturar continuamente os multiplicadores diretamente do DOM;
- guardar os últimos registros em memória;
- expor os dados em `GET /api/velas`;
- rodar 24h usando PM2.

## Estrutura

```text
aviator-bot/
├── bot.js
├── ecosystem.config.cjs
├── package.json
└── cookies.json   # gerado automaticamente em runtime
```

## Instalação

```bash
cd aviator-bot
npm install
```

## Configuração

Defina as credenciais e, se necessário, seletores alternativos via variáveis de ambiente.

```bash
export MEGAGAME_USERNAME="seu-usuario"
export MEGAGAME_PASSWORD="sua-senha"
export BOT_AUTH_MODE=auto
export PORT=3000
export BOT_HEADLESS=true
export CAPTURE_INTERVAL_MS=5000
export SELETOR_VELAS='div.payout[appcoloredmultiplier]'
```

### Modos de autenticação

- `BOT_AUTH_MODE=auto`: tenta cookies, depois credenciais e, se estiver local com `BOT_HEADLESS=false`, permite login manual.
- `BOT_AUTH_MODE=credentials`: força login com `MEGAGAME_USERNAME` e `MEGAGAME_PASSWORD`.
- `BOT_AUTH_MODE=manual`: abre o browser para você iniciar sessão uma vez, salva `cookies.json` automaticamente e injeta o agente de captura baseado no script que você usava no console.

### Bootstrap manual de cookies

Se quiser exatamente o fluxo de “abrir o browser, fazer login uma vez e o bot salvar os cookies / colar o script automaticamente”, rode:

```bash
npm run bootstrap
```

Ou manualmente:

```bash
BOT_AUTH_MODE=manual BOT_HEADLESS=false npm start
```

Depois de você iniciar sessão no site, o bot salva `cookies.json`, abre o Aviator e injeta automaticamente o agente de captura dentro da página.

### Seletores de login opcionais

Caso o site altere os campos de login, ajuste:

```bash
export LOGIN_USERNAME_SELECTOR="#username,input[name='username']"
export LOGIN_PASSWORD_SELECTOR="#password,input[name='password']"
export LOGIN_SUBMIT_SELECTOR="#login-button,button[type='submit']"
```

## Rodando localmente

```bash
npm start
```

> Dica: para gerar cookies localmente antes de subir na Render, use `npm run bootstrap`.

## API disponível

### `GET /api/velas`
Retorna os registros mais recentes capturados em memória.

### `POST /api/velas`
Permite injetar registros manualmente para testes.

Exemplo de payload:

```json
{
  "timestamp": "2026-03-18T00:00:00.000Z",
  "velas": ["1.23x", "2.15x"],
  "meta": {
    "origem": "teste"
  }
}
```

### `GET /api/status`
Mostra informações resumidas do bot, último login, último snapshot e seletores ativos.

### `GET /health`
Healthcheck simples para monitoramento.

## PM2 / 24h

```bash
cd aviator-bot
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
pm2 logs aviator-bot
```

## Deploy na Render

O repositório já inclui um `render.yaml` na raiz e um `.puppeteerrc.cjs` dentro de `aviator-bot/` para facilitar o deploy.

### O que já foi configurado

- `rootDir: aviator-bot` para a Render publicar somente a aplicação do bot;
- `buildCommand: npm run render-build` para instalar dependências e baixar o navegador do Puppeteer durante o build;
- `startCommand: npm start`;
- `healthCheckPath: /health`;
- cache local do Puppeteer em `.cache/puppeteer`;
- variáveis sensíveis (`MEGAGAME_USERNAME` e `MEGAGAME_PASSWORD`) marcadas para preenchimento manual no painel da Render.

### Como subir

1. Faça push do repositório.
2. Na Render, crie o serviço a partir do `render.yaml` usando Blueprint.
3. Preencha as variáveis secretas no painel:
   - `MEGAGAME_USERNAME`
   - `MEGAGAME_PASSWORD`
4. Se o site mudar, preencha opcionalmente os seletores:
   - `LOGIN_USERNAME_SELECTOR`
   - `LOGIN_PASSWORD_SELECTOR`
   - `LOGIN_SUBMIT_SELECTOR`
   - `SELETOR_VELAS`
5. Faça o primeiro deploy e acompanhe `Logs` + `Events`.

### Observações específicas da Render

- O bot já respeita a porta dinâmica via `process.env.PORT`.
- O Chromium pode ser forçado por `PUPPETEER_EXECUTABLE_PATH`, mas em geral a build já baixa um browser compatível automaticamente.
- Para a Render, prefira `BOT_AUTH_MODE=credentials` ou cookies já gerados; o fluxo `manual` é pensado para o bootstrap local com browser visível.
- `cookies.json` fica no filesystem do container; em novo deploy/restart ele pode ser recriado pelo próprio login automático.

## Observações

- `cookies.json` é salvo automaticamente após o login para reaproveitamento futuro.
- O agente injetado no browser usa a mesma ideia do script manual fornecido: seletor customizável, fallback para múltiplos métodos e envio automático quando as velas mudam.
- Se o browser ou a página falharem, o processo tenta reiniciar automaticamente após 15 segundos.
- Os últimos `MAX_REGISTROS` registros ficam em memória para consumo do frontend.
