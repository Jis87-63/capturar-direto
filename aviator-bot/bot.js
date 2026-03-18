import express from "express";
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const APP_URL = process.env.APP_URL || "https://megagamelive.com";
const LOGIN_URL = process.env.LOGIN_URL || `${APP_URL}/login`;
const AVIATOR_URL = process.env.AVIATOR_URL || `${APP_URL}/aviator`;
const USERNAME = process.env.MEGAGAME_USERNAME || "";
const PASSWORD = process.env.MEGAGAME_PASSWORD || "";
const BOT_HEADLESS = process.env.BOT_HEADLESS !== "false";
const BOT_AUTH_MODE = (process.env.BOT_AUTH_MODE || "auto").toLowerCase();
const CAPTURE_INTERVAL_MS = Number(process.env.CAPTURE_INTERVAL_MS || 5000);
const NAVIGATION_TIMEOUT_MS = Number(process.env.NAVIGATION_TIMEOUT_MS || 60000);
const MANUAL_LOGIN_TIMEOUT_MS = Number(process.env.MANUAL_LOGIN_TIMEOUT_MS || 300000);
const MAX_REGISTROS = Number(process.env.MAX_REGISTROS || 100);
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const COOKIES_PATH = path.join(__dirname, "cookies.json");
const EXPOSED_CAPTURE_FUNCTION = "__aviatorPushCapture";
const DEFAULT_SELECTOR = 'div.payout[appcoloredmultiplier]';
const DEFAULT_SELECTORS = [
  DEFAULT_SELECTOR,
  'div[class*="payout"]',
  'div[style*="rgb(52, 180, 255)"]',
  'div[style*="rgb(145, 62, 248)"]',
  'div[style*="rgb(192, 23, 180)"]',
  'div[class*="payouts-block"] div[style*="color"]',
  '[class*="stats"] div[style*="rgb"]'
];
const USER_SELECTORS = (process.env.SELETOR_VELAS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const SELECTORS = [...new Set([...USER_SELECTORS, ...DEFAULT_SELECTORS])];
const LOGIN_SELECTORS = {
  username: (process.env.LOGIN_USERNAME_SELECTOR || "#username,input[name='username'],input[type='text']")
    .split(",")
    .map((item) => item.trim()),
  password: (process.env.LOGIN_PASSWORD_SELECTOR || "#password,input[name='password'],input[type='password']")
    .split(",")
    .map((item) => item.trim()),
  submit: (process.env.LOGIN_SUBMIT_SELECTOR || "#login-button,button[type='submit'],button")
    .split(",")
    .map((item) => item.trim())
};

const state = {
  iniciadoEm: new Date().toISOString(),
  modoAutenticacao: BOT_AUTH_MODE,
  browserAtivo: false,
  paginaAtual: null,
  frameAtual: null,
  agenteInjetadoEm: null,
  ultimoHeartbeat: null,
  ultimoErro: null,
  ultimoSnapshot: null,
  ultimoFingerprint: "",
  ultimoLoginEm: null,
  origemSessao: null,
  capturas: []
};

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    iniciadoEm: state.iniciadoEm,
    modoAutenticacao: state.modoAutenticacao,
    origemSessao: state.origemSessao,
    browserAtivo: state.browserAtivo,
    paginaAtual: state.paginaAtual,
    frameAtual: state.frameAtual,
    agenteInjetadoEm: state.agenteInjetadoEm,
    ultimoHeartbeat: state.ultimoHeartbeat,
    ultimoErro: state.ultimoErro
  });
});

app.get("/api/velas", (_req, res) => {
  res.json(state.capturas);
});

app.get("/api/status", (_req, res) => {
  res.json({
    totalRegistros: state.capturas.length,
    ultimoSnapshot: state.ultimoSnapshot,
    ultimoLoginEm: state.ultimoLoginEm,
    origemSessao: state.origemSessao,
    seletores: SELECTORS,
    cookiesSalvos: fs.existsSync(COOKIES_PATH)
  });
});

app.post("/api/velas", (req, res) => {
  const { velas = [], timestamp = new Date().toISOString(), meta = {} } = req.body || {};

  if (!Array.isArray(velas)) {
    return res.status(400).json({ error: "O campo velas precisa ser um array." });
  }

  persistirCaptura({ timestamp, velas, meta });
  return res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`[api] Servidor rodando na porta ${PORT}`);
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function atualizarErro(error) {
  state.ultimoErro = {
    em: new Date().toISOString(),
    mensagem: error instanceof Error ? error.message : String(error)
  };
}

function persistirCaptura({ timestamp, velas, meta = {} }) {
  const valores = velas
    .map((item) => Number.parseFloat(String(item).replace(/x$/i, "")))
    .filter((value) => Number.isFinite(value));

  const registro = {
    timestamp,
    velas,
    ultimaVela: velas[0] || null,
    totalVelas: velas.length,
    maiorVela: valores.length ? Math.max(...valores) : null,
    menorVela: valores.length ? Math.min(...valores) : null,
    media: valores.length ? Number((valores.reduce((acc, value) => acc + value, 0) / valores.length).toFixed(2)) : null,
    velasAltas: valores.filter((value) => value >= 10).length,
    velasBaixas: valores.filter((value) => value < 2).length,
    meta
  };

  state.capturas.push(registro);
  if (state.capturas.length > MAX_REGISTROS) {
    state.capturas.shift();
  }

  state.ultimoFingerprint = velas.join(",");
  state.ultimoSnapshot = registro;
  state.ultimoHeartbeat = new Date().toISOString();

  console.log(`[captura] ${registro.timestamp} | total=${registro.totalVelas} | última=${registro.ultimaVela || "n/a"}`);
}

async function carregarCookies(page) {
  if (!fs.existsSync(COOKIES_PATH)) {
    return false;
  }

  const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, "utf8"));
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return false;
  }

  await page.setCookie(...cookies);
  console.log(`[bot] ${cookies.length} cookies restaurados.`);
  return true;
}

async function salvarCookies(page) {
  const cookies = await page.cookies();
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
  console.log(`[bot] ${cookies.length} cookies salvos em ${COOKIES_PATH}.`);
}

async function esperarPrimeiroSeletor(page, selectors, timeout = 15000) {
  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { timeout });
      return selector;
    } catch {
      // tenta o próximo seletor
    }
  }

  throw new Error(`Nenhum seletor encontrado: ${selectors.join(" | ")}`);
}

async function preencherCampo(page, selectors, value) {
  const selector = await esperarPrimeiroSeletor(page, selectors);
  await page.click(selector, { clickCount: 3 });
  await page.type(selector, value, { delay: 35 });
  return selector;
}

async function efetuarLoginComCredenciais(page) {
  if (!USERNAME || !PASSWORD) {
    throw new Error("Defina MEGAGAME_USERNAME e MEGAGAME_PASSWORD antes de iniciar o bot em modo credentials.");
  }

  console.log(`[bot] Abrindo login em ${LOGIN_URL}`);
  await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: NAVIGATION_TIMEOUT_MS });

  const userSelector = await preencherCampo(page, LOGIN_SELECTORS.username, USERNAME);
  const passwordSelector = await preencherCampo(page, LOGIN_SELECTORS.password, PASSWORD);
  const submitSelector = await esperarPrimeiroSeletor(page, LOGIN_SELECTORS.submit);

  console.log(`[bot] Login preenchido com ${userSelector} / ${passwordSelector} / ${submitSelector}`);

  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: NAVIGATION_TIMEOUT_MS }),
    page.click(submitSelector)
  ]);

  await salvarCookies(page);
  state.ultimoLoginEm = new Date().toISOString();
  state.origemSessao = "credentials";
}

async function aguardarLoginManual(page) {
  if (BOT_HEADLESS) {
    throw new Error("BOT_AUTH_MODE=manual exige BOT_HEADLESS=false para você poder iniciar sessão e salvar os cookies.");
  }

  console.log(`[bot] Modo manual ativo. Abra ${LOGIN_URL}, faça login normalmente e deixe o bot salvar os cookies.`);
  console.log(`[bot] Você tem ${Math.round(MANUAL_LOGIN_TIMEOUT_MS / 1000)} segundos para concluir o login manual.`);
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });

  const deadline = Date.now() + MANUAL_LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const cookies = await page.cookies();
    const currentUrl = page.url();

    state.paginaAtual = currentUrl;
    state.ultimoHeartbeat = new Date().toISOString();

    if (cookies.length > 0 && !currentUrl.includes("/login")) {
      await salvarCookies(page);
      state.ultimoLoginEm = new Date().toISOString();
      state.origemSessao = "manual";
      console.log("[bot] Login manual detectado e cookies salvos com sucesso.");
      return;
    }

    await sleep(2000);
  }

  throw new Error("Tempo esgotado aguardando login manual. Faça login mais rápido ou aumente MANUAL_LOGIN_TIMEOUT_MS.");
}

async function abrirAviator(page) {
  console.log(`[bot] Abrindo jogo em ${AVIATOR_URL}`);
  await page.goto(AVIATOR_URL, { waitUntil: "networkidle2", timeout: NAVIGATION_TIMEOUT_MS });
  await sleep(5000);
  state.paginaAtual = page.url();
}

async function tentarSessaoComCookies(page) {
  const carregou = await carregarCookies(page);
  if (!carregou) {
    return false;
  }

  try {
    await abrirAviator(page);
    if (page.url().includes("/login")) {
      console.log("[bot] Cookies restaurados, mas a sessão não estava mais válida.");
      return false;
    }

    state.ultimoLoginEm = new Date().toISOString();
    state.origemSessao = "cookies";
    console.log("[bot] Sessão restaurada com cookies.");
    return true;
  } catch (error) {
    console.warn("[bot] Falha ao reaproveitar cookies:", error);
    return false;
  }
}

async function autenticar(page) {
  if (await tentarSessaoComCookies(page)) {
    return;
  }

  if (BOT_AUTH_MODE === "manual") {
    await aguardarLoginManual(page);
    return;
  }

  if (BOT_AUTH_MODE === "credentials") {
    await efetuarLoginComCredenciais(page);
    return;
  }

  if (BOT_AUTH_MODE === "auto") {
    if (USERNAME && PASSWORD) {
      await efetuarLoginComCredenciais(page);
      return;
    }

    if (!BOT_HEADLESS) {
      await aguardarLoginManual(page);
      return;
    }
  }

  throw new Error(
    "Não foi possível autenticar. Use cookies válidos, configure MEGAGAME_USERNAME/MEGAGAME_PASSWORD ou rode localmente com BOT_AUTH_MODE=manual e BOT_HEADLESS=false."
  );
}

async function registrarCanalDeCaptura(page) {
  if (page.__aviatorCaptureExposed) {
    return;
  }

  await page.exposeFunction(EXPOSED_CAPTURE_FUNCTION, async (payload) => {
    const { timestamp = new Date().toISOString(), velas = [], meta = {} } = payload || {};

    if (!Array.isArray(velas) || velas.length === 0) {
      return;
    }

    if (velas.join(",") === state.ultimoFingerprint) {
      state.ultimoHeartbeat = new Date().toISOString();
      return;
    }

    persistirCaptura({ timestamp, velas, meta });
  });

  page.__aviatorCaptureExposed = true;
}

async function encontrarContextoDeCaptura(page) {
  for (const frame of page.frames()) {
    try {
      const resultado = await frame.evaluate((selectors) => {
        const regex = /^\d+(?:\.\d+)?x$/i;
        const candidatos = selectors.flatMap((selector) => {
          try {
            return Array.from(document.querySelectorAll(selector));
          } catch {
            return [];
          }
        });

        const encontrouTexto = candidatos.some((node) => regex.test(node?.textContent?.trim() || ""));
        return {
          href: window.location.href,
          encontrouTexto,
          temDivs: document.querySelectorAll("div").length > 0
        };
      }, SELECTORS);

      if (resultado.encontrouTexto || resultado.href.includes("aviator")) {
        state.frameAtual = resultado.href;
        return frame;
      }
    } catch {
      // ignora frames indisponíveis
    }
  }

  state.frameAtual = page.url();
  return page.mainFrame();
}

async function injetarAgenteDeCaptura(frame, page) {
  await registrarCanalDeCaptura(page);

  const resultado = await frame.evaluate(
    ({ selectors, defaultSelector, intervalMs, exposedFunction }) => {
      const regex = /^\d+(?:\.\d+)?x$/i;
      const agentKey = "__AVIATOR_AGENT__";

      const pegarVelas = () => {
        let elementos = [];

        const adicionar = (nodes) => {
          elementos = Array.from(nodes || []);
          return elementos.length > 0;
        };

        const seletorAtual = window.SELETOR_VELAS || selectors[0] || defaultSelector;

        try {
          if (adicionar(document.querySelectorAll(seletorAtual))) {
            window.__AVIATOR_LAST_SELECTOR__ = seletorAtual;
          }
        } catch {
          // ignora seletor customizado inválido
        }

        if (elementos.length === 0) {
          const metodos = [
            () => document.querySelectorAll(defaultSelector),
            () => document.querySelectorAll('div[class*="payout"]'),
            () => document.querySelectorAll('div[style*="rgb(52, 180, 255)"], div[style*="rgb(145, 62, 248)"], div[style*="rgb(192, 23, 180)"]'),
            () => {
              const bloco = document.querySelector('div[class*="payouts-block"]');
              return bloco ? bloco.querySelectorAll('div[style*="color"]') : [];
            },
            () => {
              const widget = document.querySelector('[class*="stats"]');
              return widget ? widget.querySelectorAll('div[style*="rgb"]') : [];
            },
            () => Array.from(document.querySelectorAll("div")).filter((div) => regex.test(div.textContent?.trim() || ""))
          ];

          for (const metodo of metodos) {
            try {
              if (adicionar(metodo())) {
                break;
              }
            } catch {
              // ignora método inválido
            }
          }
        }

        return Array.from(new Set(
          elementos
            .map((node) => node?.textContent?.trim())
            .filter((text) => regex.test(text || ""))
        ));
      };

      if (window[agentKey]?.intervalId) {
        clearInterval(window[agentKey].intervalId);
      }

      window.SELETOR_VELAS = window.SELETOR_VELAS || selectors[0] || defaultSelector;
      window[agentKey] = {
        contador: 0,
        intervalMs,
        startedAt: new Date().toISOString(),
        lastFingerprint: "",
        lastError: null,
        lastSentAt: null,
        url: window.location.href,
        selectorAtual: window.SELETOR_VELAS
      };

      const tick = async () => {
        try {
          const velas = pegarVelas();
          if (!velas.length) {
            return;
          }

          const fingerprint = velas.join(",");
          if (fingerprint === window[agentKey].lastFingerprint) {
            return;
          }

          window[agentKey].contador += 1;
          window[agentKey].lastFingerprint = fingerprint;
          window[agentKey].lastSentAt = new Date().toISOString();
          window[agentKey].url = window.location.href;
          window[agentKey].selectorAtual = window.SELETOR_VELAS;

          await window[exposedFunction]({
            timestamp: new Date().toISOString(),
            velas,
            meta: {
              origem: "page-agent",
              contador: window[agentKey].contador,
              url: window.location.href,
              seletorAtual: window.SELETOR_VELAS,
              seletoresPadrao: selectors
            }
          });
        } catch (error) {
          window[agentKey].lastError = error?.message || String(error);
        }
      };

      window[agentKey].intervalId = window.setInterval(() => {
        void tick();
      }, intervalMs);

      void tick();

      return {
        ok: true,
        startedAt: window[agentKey].startedAt,
        intervalMs,
        selectorAtual: window.SELETOR_VELAS,
        url: window.location.href
      };
    },
    {
      selectors: SELECTORS,
      defaultSelector: DEFAULT_SELECTOR,
      intervalMs: CAPTURE_INTERVAL_MS,
      exposedFunction: EXPOSED_CAPTURE_FUNCTION
    }
  );

  state.agenteInjetadoEm = new Date().toISOString();
  state.frameAtual = frame.url();
  console.log(`[bot] Agente de captura injetado em ${resultado.url} usando ${resultado.selectorAtual}.`);
}

async function lerStatusDoAgente(frame) {
  try {
    return await frame.evaluate(() => {
      const agent = window.__AVIATOR_AGENT__;
      if (!agent) {
        return null;
      }

      return {
        startedAt: agent.startedAt,
        lastSentAt: agent.lastSentAt,
        lastError: agent.lastError,
        selectorAtual: agent.selectorAtual,
        url: window.location.href
      };
    });
  } catch {
    return null;
  }
}

async function monitorarCaptura(page) {
  console.log("[bot] Monitorando o agente de captura injetado na página...");

  while (true) {
    const frame = await encontrarContextoDeCaptura(page);
    state.paginaAtual = page.url();
    state.frameAtual = frame.url();

    const statusAtual = await lerStatusDoAgente(frame);
    if (!statusAtual) {
      await injetarAgenteDeCaptura(frame, page);
    } else if (statusAtual.lastError) {
      console.warn(`[bot] Agente reportou erro: ${statusAtual.lastError}`);
    }

    state.ultimoHeartbeat = new Date().toISOString();
    await sleep(CAPTURE_INTERVAL_MS);
  }
}

async function iniciarBot() {
  while (true) {
    let browser;

    try {
      console.log("[bot] Inicializando browser...");
      browser = await puppeteer.launch({
        headless: BOT_HEADLESS,
        executablePath: PUPPETEER_EXECUTABLE_PATH,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
      });

      const page = await browser.newPage();
      page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
      state.browserAtivo = true;

      await autenticar(page);
      await abrirAviator(page);
      await monitorarCaptura(page);
    } catch (error) {
      atualizarErro(error);
      console.error("[bot] Falha no loop principal:", error);
    } finally {
      state.browserAtivo = false;
      state.paginaAtual = null;
      state.frameAtual = null;
      state.agenteInjetadoEm = null;
      if (browser) {
        await browser.close().catch(() => {});
      }
      console.log("[bot] Reiniciando em 15 segundos...");
      await sleep(15000);
    }
  }
}

iniciarBot().catch((error) => {
  atualizarErro(error);
  console.error("[bot] Erro fatal:", error);
  process.exitCode = 1;
});
