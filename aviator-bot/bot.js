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
const CAPTURE_INTERVAL_MS = Number(process.env.CAPTURE_INTERVAL_MS || 5000);
const NAVIGATION_TIMEOUT_MS = Number(process.env.NAVIGATION_TIMEOUT_MS || 60000);
const MAX_REGISTROS = Number(process.env.MAX_REGISTROS || 100);
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const COOKIES_PATH = path.join(__dirname, "cookies.json");
const DEFAULT_SELECTORS = [
  'div.payout[appcoloredmultiplier]',
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
  ultimoHeartbeat: null,
  ultimoErro: null,
  ultimoSnapshot: null,
  ultimoFingerprint: "",
  ultimoLoginEm: null,
  browserAtivo: false,
  paginaAtual: null,
  capturas: []
};

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    iniciadoEm: state.iniciadoEm,
    browserAtivo: state.browserAtivo,
    paginaAtual: state.paginaAtual,
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
    seletores: SELECTORS
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

async function efetuarLogin(page) {
  if (!USERNAME || !PASSWORD) {
    throw new Error("Defina MEGAGAME_USERNAME e MEGAGAME_PASSWORD antes de iniciar o bot.");
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
}

async function abrirAviator(page) {
  console.log(`[bot] Abrindo jogo em ${AVIATOR_URL}`);
  await page.goto(AVIATOR_URL, { waitUntil: "networkidle2", timeout: NAVIGATION_TIMEOUT_MS });
  await sleep(5000);
  state.paginaAtual = page.url();
}

async function capturarVelas(page) {
  return page.evaluate((selectors) => {
    const regex = /^\d+(?:\.\d+)?x$/i;
    const colecao = new Set();

    const adicionarElementos = (nodes) => {
      Array.from(nodes || [])
        .map((node) => node?.textContent?.trim())
        .filter((text) => regex.test(text || ""))
        .forEach((text) => colecao.add(text));
    };

    for (const selector of selectors) {
      try {
        adicionarElementos(document.querySelectorAll(selector));
      } catch {
        // seletor inválido, ignora
      }
    }

    if (colecao.size === 0) {
      adicionarElementos(
        Array.from(document.querySelectorAll("div")).filter((div) => regex.test(div.textContent?.trim() || ""))
      );
    }

    return Array.from(colecao);
  }, SELECTORS);
}

async function iniciarLoopCaptura(page) {
  console.log(`[bot] Iniciando captura contínua a cada ${CAPTURE_INTERVAL_MS}ms`);

  while (true) {
    const velas = await capturarVelas(page);
    const fingerprint = velas.join(",");

    if (fingerprint && fingerprint !== state.ultimoFingerprint) {
      state.ultimoFingerprint = fingerprint;
      persistirCaptura({
        timestamp: new Date().toISOString(),
        velas,
        meta: {
          url: page.url(),
          selectors: SELECTORS
        }
      });
    } else {
      state.ultimoHeartbeat = new Date().toISOString();
      console.log("[captura] sem mudanças, aguardando próxima leitura...");
    }

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

      await carregarCookies(page);
      await efetuarLogin(page);
      await abrirAviator(page);
      await iniciarLoopCaptura(page);
    } catch (error) {
      state.ultimoErro = {
        em: new Date().toISOString(),
        mensagem: error instanceof Error ? error.message : String(error)
      };
      console.error("[bot] Falha no loop principal:", error);
    } finally {
      state.browserAtivo = false;
      state.paginaAtual = null;
      if (browser) {
        await browser.close().catch(() => {});
      }
      console.log("[bot] Reiniciando em 15 segundos...");
      await sleep(15000);
    }
  }
}

iniciarBot().catch((error) => {
  state.ultimoErro = {
    em: new Date().toISOString(),
    mensagem: error instanceof Error ? error.message : String(error)
  };
  console.error("[bot] Erro fatal:", error);
  process.exitCode = 1;
});
