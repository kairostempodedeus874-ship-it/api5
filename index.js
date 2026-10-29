/*
 * Kairós — Servidor de WhatsApp (Baileys) — v5.5.0
 * ------------------------------------------------------------------
 * Este processo precisa ficar LIGADO 24h: ele mantém a conexão com o
 * WhatsApp (WebSocket) e a sessão gravada em disco. Por isso ele roda em
 * um container sempre ativo (Railway, Render, VPS...), nunca em serverless.
 *
 * Responsabilidades (v5.5.0 — SOMENTE ENVIO):
 *   1. Manter a sessão do WhatsApp conectada (QR Code ou sessão salva).
 *   2. ENVIAR notificações (cobrança, confirmação de pagamento, teste).
 *   3. Guardar o comprovante técnico de envio/entrega de cada mensagem.
 *   4. NÃO ler, NÃO interpretar e NÃO responder mensagens recebidas.
 *
 * ───────────────── POR QUE O BALÃO "AGUARDANDO MENSAGEM" ACONTECIA ─────────────────
 * O balão cinza com relógio no celular do cliente é o próprio WhatsApp dizendo
 * "recebi um envelope e não consegui abrir". Ele acontecia por TRÊS motivos
 * distintos, todos no nosso lado, e todos corrigidos aqui:
 *
 *   (a) BIBLIOTECA ANTIGA. O projeto usava @whiskeysockets/baileys ^6.7.0, uma
 *       faixa de versões anterior à migração do WhatsApp para endereçamento LID
 *       (identidade interna, formato @lid). Com ela, a mensagem era cifrada para
 *       <numero>@s.whatsapp.net enquanto o aparelho do cliente já esperava um
 *       envelope endereçado ao LID dele. Resultado: o cliente recebe, não abre e
 *       fica preso no balão. Agora a versão é fixa e nova (6.7.20, com LID).
 *
 *   (b) ENDEREÇO ERRADO. A versão anterior tentava enviar para found.lid quando
 *       o número não vinha em found.jid. Enviar para @lid SEM ter a sessão de
 *       criptografia daquele LID produz EXATAMENTE o mesmo envelope ilegível.
 *       Agora nunca se envia para @lid sem mapeamento: usa-se o JID do número.
 *
 *   (c) CACHE SÓ EM MEMÓRIA. Quando o cliente pede a mensagem de volta (é assim
 *       que o balão se destrava), o servidor precisa devolver a ORIGINAL. O cache
 *       era um Map em memória: todo deploy/reinício zerava, e as mensagens
 *       voltavam a ficar presas. Agora o cache é gravado em DISCO, 24h.
 *
 * Nada disso se resolve mexendo no celular do cliente. É do lado do servidor.
 *
 * A sessão fica salva na pasta WPP_AUTH_DIR. Essa pasta PRECISA estar em um
 * volume persistente, senão a sessão é perdida a cada deploy/reinício.
 *
 * Variáveis de ambiente (v5.3.0 — NENHUMA é obrigatória):
 *   PORT                  porta HTTP (padrão 8080, injetada pela hospedagem)
 *   WPP_API_KEY           opcional (tem padrão que combina com o painel)
 *   WPP_AGENT_SECRET      opcional (tem padrão que combina com o wpp-agente)
 *   SUPABASE_URL          opcional (tem padrão apontando para o Backend)
 *   WPP_AUTH_DIR          opcional — a pasta da sessão é detectada sozinha
 *   WPP_PUBLIC_URL        opcional — a URL pública é detectada sozinha
 *   TZ                    America/Sao_Paulo (recomendado)
 *
 * IMPORTANTE (v5.3.0): este servidor NÃO usa a chave de serviço do Backend.
 * Ela não é exposta ao usuário. Todo acesso ao banco é feito pela função
 * wpp-agente, autenticada com a chave do agente. Resultado: nada de chave
 * secreta copiada para o painel da hospedagem, e permissão completa no banco.
 */

require("dotenv").config();

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const cron = require("node-cron");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require("@whiskeysockets/baileys");

const SERVER_VERSION = "5.5.0";

// ───────────────────── MODO SOMENTE ENVIO (v5.5.0) ─────────────────────
// Este servidor serve EXCLUSIVAMENTE para ENVIAR notificações.
// Com o modo padrão ("envio"):
//   • NÃO lê o conteúdo das mensagens que os clientes mandam
//   • NÃO interpreta conversa, NÃO responde ninguém, NÃO cria chatbot
//   • NÃO executa comando com base no que o cliente escreve
// O único evento recebido que continua sendo lido é o COMPROVANTE TÉCNICO de
// entrega (messages.update), que é indispensável para saber se a mensagem
// realmente chegou. Ele não tem conteúdo de conversa nenhum.
// Para voltar ao atendimento por IA, defina WPP_MODO=atendimento.
const MODO_ENVIO_ONLY =
  String(process.env.WPP_MODO || "envio")
    .trim()
    .toLowerCase() !== "atendimento";

// Marco do realinhamento automático de chaves.
// Guardado no disco para rodar UMA vez por versão, não a cada reinício.
// v5.5.0 usa uma marca nova de propósito: a primeira subida desta versão
// descarta as chaves de conversa herdadas da versão problemática.
const REALIGN_MARK = "crypto_v550";

// ───────────────────────────── Configuração ─────────────────────────────
// IMPORTANTE (causa nº1 de "deploy ok mas URL muda"):
// cada hospedagem faz a checagem de saúde numa porta. O Railway injeta PORT
// sozinho; o Fly, quando gera a configuração dele, usa 8080. Se o processo
// escutar em outra porta, a máquina é CRIADA mas nunca chega a "started" — e a
// URL responde "Request failed" para sempre (o log mostra servicecheck...-http-8080).
// Por isso o padrão é 8080, com escuta extra em 3000/3001 como rede de segurança.
const PORT = Number(process.env.PORT || 8080);
// REDE DE SEGURANÇA DE PORTAS (v5.1.2):
// O launcher web do Fly frequentemente gera um fly.toml com
// internal_port = 3000 (o padrão que ele usa para Node). Se o servidor
// escuta só em 8080/3001, quem atende é ninguém e o deploy termina com
// "Solicitação falhada" — mesmo com a máquina ligada e saudável.
// Escutando também na 3000, a checagem de saúde acerta em qualquer cenário.
const FALLBACK_PORTS = [8080, 3000, 3001].filter((p) => p !== PORT);
const API_KEY = process.env.WPP_API_KEY || "kairos_wpp_2026_7f3b9d2a";
const AGENT_SECRET = process.env.WPP_AGENT_SECRET || "kairos_ag_2026_2d8e5b1c";
const SUPABASE_URL = String(
  process.env.SUPABASE_URL || "https://het13a1zo93y9y95701f.helloreaddy.com/"
).replace(/\/+$/, "");
// v5.3.0 — Sem chave de serviço: a função wpp-agente faz o acesso ao banco.
// Assim o servidor tem permissão total sem você copiar nenhuma chave secreta.
const AGENT_URL = SUPABASE_URL + "/functions/v1/wpp-agente";

// ── Pasta da sessão: detectada sozinha (v5.2.0) ──────────────────────
// Antes essa pasta precisava ser digitada na mão (WPP_AUTH_DIR). Quando o
// caminho saía errado, a sessão era gravada na área temporária do container
// e o WhatsApp "desconectava sozinho" a cada reinício — era o erro mais
// comum de todos. Agora o servidor procura um disco montado e usa o
// primeiro que encontrar. WPP_AUTH_DIR continua funcionando se você quiser
// forçar um caminho específico.
function detectAuthDir() {
  const manual = String(process.env.WPP_AUTH_DIR || "").trim();
  if (manual) return { dir: manual, origem: "definida na variável WPP_AUTH_DIR" };
  const candidatos = [
    "/var/data",  // Render (disco criado pelo blueprint)
    "/data",      // Fly.io, Railway, EasyPanel, Docker com volume
    "/mnt/data",  // VPS com volume extra
    "/home/data", // alguns painéis
  ];
  for (const base of candidatos) {
    try {
      if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
        return { dir: path.join(base, "wpp-auth"), origem: "disco detectado em " + base };
      }
    } catch (e) {
      /* tenta o próximo */
    }
  }
  return { dir: "./wpp-auth", origem: "pasta local (NÃO persistente)" };
}

const AUTH_DETECT = detectAuthDir();
const AUTH_DIR = AUTH_DETECT.dir;

// Um diretório está em disco persistente quando pertence a um "device"
// diferente do diretório da aplicação — ou seja, é um volume montado.
// Isso evita o falso "está tudo bem" quando a pasta é temporária.
function isPersistentDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return fs.statSync(dir).dev !== fs.statSync(process.cwd()).dev;
  } catch (e) {
    return false;
  }
}

const AUTH_PERSISTENT = isPersistentDir(AUTH_DIR);
const STATE_FILE = path.join(AUTH_DIR, "server-state.json");
const MAX_RECONNECT = 12;
const LOG_PREFIX = "[wpp]";
const HORA_COBRANCA = 11; // 11:00 no horário de Brasília

const logger = pino({ level: "silent" });
const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Nada pode derrubar o processo: a sessão do WhatsApp precisa ficar viva.
process.on("uncaughtException", (err) => {
  console.error(LOG_PREFIX, "uncaughtException:", err && err.message ? err.message : err);
});
process.on("unhandledRejection", (err) => {
  console.error(LOG_PREFIX, "unhandledRejection:", err && err.message ? err.message : err);
});

// ───────────────────────────── Estado global ─────────────────────────────
const runtime = {
  status: "disconnected", // disconnected | connecting | waiting_qr | connected
  qr: null,
  lastError: null,
  sock: null,
  me: null,
  starting: false,
  attempts: 0,
  manualStop: true,
  connectedAt: null,
  lastMessageAt: null,
  messagesReceived: 0,
  messagesSent: 0,
  messagesDelivered: 0,
  messagesRead: 0,
  messagesFailed: 0,
  reconnects: 0,
  humanSent: 0,
};

// MODO SOMENTE ENVIO: nada de conteúdo de mensagem recebida é guardado.
// Só existe um contador (runtime.messagesReceived) para diagnóstico.
const STATUS_ENTREGA = {
  0: "falhou",
  1: "pendente",
  2: "enviado",
  3: "entregue",
  4: "lido",
  5: "lido",
};

// ───────────── Cache PERSISTENTE das mensagens enviadas (v5.5.0) ─────────────
// POR QUE ISSO EXISTE — é o que destrava o balão "Aguardando mensagem":
// quando o aparelho do cliente recebe uma mensagem e não consegue decifrar, o
// WhatsApp dele pede de volta o conteúdo original para quem enviou. Quem enviou
// PRECISA responder com a mensagem de verdade e reassinada, e é o Baileys que
// reassina — desde que o handler getMessage devolva o conteúdo original.
//
// Na v5.3.1 esse cache era um Map em MEMÓRIA. Todo deploy/reinício apagava,
// e as mensagens voltavam a ficar presas. Agora é gravado em DISCO, dentro da
// pasta da sessão (volume persistente), com validade de 24 horas.
const SENT_CACHE_DIR = path.join(AUTH_DIR, "sent-cache");
const SENT_TTL = 24 * 60 * 60 * 1000; // 24 horas
const sentMessages = new Map(); // atalho em memória (evita ler disco toda hora)

function ensureSentCacheDir() {
  try {
    fs.mkdirSync(SENT_CACHE_DIR, { recursive: true });
  } catch (e) {
    /* sem disco: o cache em memória ainda funciona */
  }
}

function sentCachePath(id) {
  const seguro = String(id || "").replace(/[^A-Za-z0-9_-]/g, "");
  return path.join(SENT_CACHE_DIR, seguro + ".json");
}

function rememberSent(id, message, jid) {
  if (!id || !message) return;
  const em = Date.now();
  sentMessages.set(id, { message: message, em: em });
  try {
    ensureSentCacheDir();
    fs.writeFileSync(
      sentCachePath(id),
      JSON.stringify({ id: id, jid: jid || null, em: em, message: message })
    );
  } catch (e) {
    console.error(LOG_PREFIX, "Não foi possível gravar o cache de envio:", e.message);
  }
}

function getSentMessage(id) {
  if (!id) return null;
  const memo = sentMessages.get(id);
  if (memo) {
    if (Date.now() - memo.em <= SENT_TTL) return memo.message;
    sentMessages.delete(id);
  }
  try {
    const bruto = JSON.parse(fs.readFileSync(sentCachePath(id), "utf8"));
    if (!bruto || !bruto.message) return null;
    const em = Number(bruto.em || 0);
    if (!em || Date.now() - em > SENT_TTL) {
      try {
        fs.rmSync(sentCachePath(id), { force: true });
      } catch (e) {
        /* ignora */
      }
      return null;
    }
    sentMessages.set(id, { message: bruto.message, em: em });
    return bruto.message;
  } catch (e) {
    return null;
  }
}

// Limpa do disco o que passou de 24h (roda na subida e de hora em hora).
function cleanupSentCache() {
  let removidos = 0;
  try {
    ensureSentCacheDir();
    for (const arquivo of fs.readdirSync(SENT_CACHE_DIR)) {
      const completo = path.join(SENT_CACHE_DIR, arquivo);
      try {
        if (Date.now() - fs.statSync(completo).mtimeMs > SENT_TTL) {
          fs.rmSync(completo, { force: true });
          removidos += 1;
        }
      } catch (e) {
        /* segue */
      }
    }
  } catch (e) {
    /* ignora */
  }
  return removidos;
}

function contarCacheEnvio() {
  try {
    return fs.readdirSync(SENT_CACHE_DIR).length;
  } catch (e) {
    return 0;
  }
}

// Cache minúsculo usado para o contador de retentativas do Baileys.
// Sem ele, o mesmo pedido de reenvio pode entrar em loop.
function createTinyCache() {
  const data = new Map();
  return {
    get: (k) => {
      const item = data.get(k);
      if (!item) return undefined;
      if (item.exp && item.exp < Date.now()) {
        data.delete(k);
        return undefined;
      }
      return item.value;
    },
    set: (k, value, ttlSegundos) => {
      data.set(k, { value: value, exp: ttlSegundos ? Date.now() + ttlSegundos * 1000 : 0 });
    },
    del: (k) => {
      data.delete(k);
    },
    flushAll: () => data.clear(),
  };
}

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function setError(message) {
  runtime.lastError = message ? String(message).slice(0, 400) : null;
}

// ───────────── Versão real da biblioteca do WhatsApp ─────────────
// Lida do pacote que está INSTALADO (não do package.json, que é só a intenção).
// É o primeiro lugar a olhar quando o balão "Aguardando mensagem" reaparece:
// versão antiga do Baileys não entende o endereçamento LID do WhatsApp.
function versaoBaileys() {
  try {
    return require("@whiskeysockets/baileys/package.json").version || "desconhecida";
  } catch (e) {
    return "desconhecida";
  }
}

function baileysAntigo() {
  const bruto = versaoBaileys();
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(bruto);
  if (!m) return false;
  const maior = Number(m[1]);
  const medio = Number(m[2]);
  const menor = Number(m[3]);
  if (maior > 6) return false;
  if (maior === 6 && medio > 7) return false;
  // 6.7.18 foi a primeira da linha 6.7 com suporte a LID.
  if (maior === 6 && medio === 7 && menor >= 18) return false;
  return true;
}

// ───────────── Trava de instância (v5.5.0) ─────────────
// Se dois serviços apontarem para o MESMO disco, os dois usam a mesma sessão e
// ficam corrompendo as chaves de conversa um do outro em loop — e o sintoma no
// celular do cliente é justamente o balão "Aguardando mensagem".
// Aqui não bloqueamos a subida (isso poderia te trancar fora do painel); só
// gravamos um batimento e expomos o conflito no diagnóstico.
const LOCK_FILE = path.join(AUTH_DIR, "instance.lock");

function escreverLock() {
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(
      LOCK_FILE,
      JSON.stringify({
        pid: process.pid,
        em: Date.now(),
        versao: SERVER_VERSION,
        host: os.hostname(),
      })
    );
  } catch (e) {
    /* ignora */
  }
}

function lerLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
  } catch (e) {
    return null;
  }
}

// Devolve o outro processo quando existe um batimento recente de PID diferente.
function conflitoInstancias() {
  const lock = lerLock();
  if (!lock) return null;
  if (Number(lock.pid) === process.pid) return null;
  if (Date.now() - Number(lock.em || 0) > 90000) return null;
  return lock;
}

// ───────────── Plataforma / URLs ─────────────
// Detecta a URL pública sem depender de uma hospedagem específica.
function detectPublicUrl() {
  const fromEnv = String(process.env.WPP_PUBLIC_URL || "").trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  if (process.env.FLY_APP_NAME) return "https://" + process.env.FLY_APP_NAME + ".fly.dev";
  if (process.env.RENDER_EXTERNAL_URL) return String(process.env.RENDER_EXTERNAL_URL).replace(/\/+$/, "");
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return "https://" + process.env.RAILWAY_PUBLIC_DOMAIN;
  if (process.env.KOYEB_PUBLIC_DOMAIN) return "https://" + process.env.KOYEB_PUBLIC_DOMAIN;
  if (process.env.COOLIFY_URL) return String(process.env.COOLIFY_URL).replace(/\/+$/, "");
  return "";
}

function detectPlatform() {
  if (process.env.FLY_APP_NAME) return "fly.io";
  if (process.env.RENDER) return "render";
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PUBLIC_DOMAIN) return "railway";
  if (process.env.KOYEB_PUBLIC_DOMAIN) return "koyeb";
  return "docker/vps";
}

const PUBLIC_URL = detectPublicUrl();
const PLATFORM = detectPlatform();

// ───────────────────────────── Estado persistido ─────────────────────────────
// Fica no volume, junto da sessão, para sobreviver a reinícios.
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) || {};
  } catch (e) {
    return {};
  }
}

function writeState(patch) {
  try {
    const state = Object.assign({}, readState(), patch);
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    return state;
  } catch (e) {
    console.error(LOG_PREFIX, "Não foi possível salvar o estado:", e.message);
    return null;
  }
}

// Data de hoje no horário de Brasília (YYYY-MM-DD).
function todayBRT() {
  try {
    return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

function minutesNowBRT() {
  try {
    const partes = new Date().toLocaleTimeString("en-GB", {
      timeZone: "America/Sao_Paulo",
      hour12: false,
    });
    const [h, m] = partes.split(":").map(Number);
    return h * 60 + m;
  } catch (e) {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }
}

// ───────────────────────────── Helpers gerais ─────────────────────────────
function normalizeNumber(phone) {
  let p = String(phone || "").replace(/\D/g, "");
  if (!p) return "";
  if (p.length <= 11) p = "55" + p;
  return p;
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error((label || "Operação") + " excedeu o tempo limite"));
    }, ms);
    Promise.resolve(promise)
      .then((value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

function formatCurrency(value) {
  return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDateBR(iso) {
  if (!iso) return "";
  const raw = String(iso).slice(0, 10);
  const d = new Date(raw + "T00:00:00");
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function credsExist() {
  try {
    return fs.existsSync(path.join(AUTH_DIR, "creds.json"));
  } catch (e) {
    return false;
  }
}

function isRegistered() {
  try {
    return !!(runtime.sock && runtime.sock.authState && runtime.sock.authState.creds.registered);
  } catch (e) {
    return false;
  }
}

function clearAuthDir() {
  try {
    const state = readState();
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    if (state.lastCobrancaDate) writeState({ lastCobrancaDate: state.lastCobrancaDate });
    return true;
  } catch (e) {
    console.error(LOG_PREFIX, "Falha ao limpar sessão:", e.message);
    return false;
  }
}

// ───────────────────── Realinhamento das chaves de conversa (v5.4.0) ─────────────────────
// POR QUE ISSO EXISTE — era o balão "Aguardando mensagem" no celular do CLIENTE,
// mesmo com o servidor conectado e o painel dizendo "enviado":
// cada conversa guarda um arquivo session-*.json por aparelho do contato. Quando
// esse arquivo sai de sincronia (cliente trocou de celular, migração do número
// para LID, reinício no meio da troca de chaves, dois processos usando o mesmo
// disco), o servidor continua cifrando com uma chave que o celular do cliente
// NÃO reconhece. A mensagem sai, o cliente recebe o envelope, não consegue abrir,
// pede o conteúdo de volta... e nunca destrava: fica no balão cinza com o relógio.
//
// A cura é apagar SÓ esses arquivos de sessão de conversa. Eles são recriados na
// hora, no envio seguinte, por uma troca nova de chaves. O creds.json (que é o
// vínculo do número com o WhatsApp) NÃO é tocado — ou seja, não precisa escanear
// QR Code de novo e a conexão não cai.
function listarArquivosSessao() {
  try {
    return fs.readdirSync(AUTH_DIR).filter((f) => f.startsWith("session-") && f.endsWith(".json"));
  } catch (e) {
    return [];
  }
}

function limparSessoesDeConversa() {
  let removidos = 0;
  for (const arquivo of listarArquivosSessao()) {
    try {
      fs.rmSync(path.join(AUTH_DIR, arquivo), { force: true });
      removidos += 1;
    } catch (e) {
      /* segue tentando os outros */
    }
  }
  return removidos;
}

// Reinicia o socket mantendo a sessão do número: só as chaves de conversa somem.
async function realinharCriptografia() {
  if (!credsExist()) {
    return { ok: false, erro: "Não existe sessão salva para realinhar. Conecte o WhatsApp primeiro." };
  }
  runtime.manualStop = true;
  try {
    if (runtime.sock) runtime.sock.end(undefined);
  } catch (e) {
    /* ignora */
  }
  runtime.sock = null;
  runtime.status = "disconnected";
  runtime.qr = null;

  const removidos = limparSessoesDeConversa();
  writeState({
    realinhamento: REALIGN_MARK,
    lastRealinhamentoAt: new Date().toISOString(),
    lastRealinhamentoQtd: removidos,
  });

  // Dá um instante para o disco respirar antes de reler as credenciais.
  await new Promise((r) => setTimeout(r, 500));

  runtime.manualStop = false;
  await connect();
  log("Chaves de conversa realinhadas. Arquivos renovados: " + removidos);
  return { ok: true, sessoes: removidos };
}

// ───────────────────────────── Agente de IA ─────────────────────────────
async function callAgent(payload) {
  try {
    const res = await withTimeout(
      fetch(AGENT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": AGENT_SECRET },
        body: JSON.stringify(payload),
      }),
      45000,
      "Agente de IA"
    );
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      console.error(LOG_PREFIX, "Resposta inválida do agente:", text.slice(0, 200));
      return null;
    }
  } catch (err) {
    console.error(LOG_PREFIX, "Falha ao chamar o agente:", err.message);
    return null;
  }
}

async function confirmMessageStatus(mensagemId, status, erro) {
  if (!mensagemId) return;
  await callAgent({
    acao: "confirmar_envio",
    mensagem_id: mensagemId,
    status: status,
    erro: erro || null,
  });
}

// Atualiza a linha do histórico de envio (whatsapp_mensagens) e guarda o ID
// real da mensagem no WhatsApp. É por esse ID que o comprovante de entrega
// (messages.update) encontra a linha certa depois.
async function atualizarEnvio(registroId, patch) {
  if (!registroId) return;
  const dados = Object.assign({}, patch);
  dados.registro_id = registroId;
  await callAgent({ acao: "atualizar_envio", dados: dados });
}

// Registra um comprovante técnico de entrega recebido do WhatsApp.
// Nenhum conteúdo de conversa é transmitido aqui — só o status.
async function registrarEntrega(mensagemIdWpp, status) {
  if (!mensagemIdWpp || !status) return;
  await callAgent({
    acao: "status_entrega",
    mensagem_id_wpp: mensagemIdWpp,
    status_entrega: status,
  });
}

// ───────────────────────────── Envio ─────────────────────────────

// Valida o número ANTES de tentar enviar. Evita gastar chamada no WhatsApp,
// evita log de erro sem sentido e evita mensagem para número inválido.
// Regras do Brasil: DDI 55 + DDD (2 dígitos, 11..99) + número de 8 ou 9 dígitos.
// Celular tem 9 dígitos e começa com 9 (o 9º dígito).
function validarNumero(phone) {
  const bruto = normalizeNumber(phone);
  if (!bruto) return { ok: false, numero: "", motivo: "Número vazio" };
  if (!bruto.startsWith("55")) {
    return { ok: false, numero: bruto, motivo: "Falta o DDI 55 (Brasil)" };
  }
  const local = bruto.slice(2);
  if (local.length !== 10 && local.length !== 11) {
    return {
      ok: false,
      numero: bruto,
      motivo: "Número com " + local.length + " dígitos — o correto é DDD + 8 ou 9 dígitos",
    };
  }
  const ddd = Number(local.slice(0, 2));
  if (ddd < 11 || ddd > 99) {
    return { ok: false, numero: bruto, motivo: "DDD inválido: " + local.slice(0, 2) };
  }
  if (local.length === 11 && local[2] !== "9") {
    return {
      ok: false,
      numero: bruto,
      motivo: "Celular de 9 dígitos precisa começar com 9 depois do DDD",
    };
  }
  return { ok: true, numero: bruto, motivo: null };
}

// Descobre o endereço real do contato no WhatsApp.
//
// ⚠️ ARMADILHA CORRIGIDA NA v5.5.0 — esta era uma das causas do balão
// "Aguardando mensagem": a versão anterior fazia `found.jid || found.lid`.
// Quando o número não vinha em `jid`, ela enviava para o LID (@lid). Só que
// enviar para @lid SEM ter a sessão de criptografia daquele LID produz um
// envelope que o aparelho do cliente NÃO consegue abrir — o cliente recebe,
// trava no balão e nunca destrava. Agora:
//   • usa-se `jid` ou `id` (identificador do NÚMERO), nunca `lid` como destino;
//   • o formato antigo @s.whatsapp.net é o destino seguro e universal;
//   • o LID só é exposto para diagnóstico.
async function resolveJid(phone) {
  const numero = normalizeNumber(phone);
  const padrao = numero + "@s.whatsapp.net";
  try {
    if (!runtime.sock || typeof runtime.sock.onWhatsApp !== "function") {
      return { jid: padrao, existe: null, motivo: "Sem conexão para consultar" };
    }
    const res = await withTimeout(runtime.sock.onWhatsApp(numero), 8000, "Consulta do número");
    if (!Array.isArray(res) || res.length === 0) {
      return { jid: padrao, existe: null, motivo: "WhatsApp não respondeu a consulta" };
    }
    const encontrado = res.find((item) => item && item.exists);
    if (!encontrado) {
      return { jid: padrao, existe: false, motivo: "Número não possui WhatsApp" };
    }
    const bruto = encontrado.jid || encontrado.id || "";
    const texto = typeof bruto === "string" ? bruto : String(bruto && bruto._serialized ? bruto._serialized : "");
    const lid = encontrado.lid || null;
    if (texto && texto.indexOf("@lid") === -1) {
      return { jid: texto, existe: true, lid: lid, motivo: null };
    }
    return { jid: padrao, existe: true, lid: lid, motivo: null };
  } catch (e) {
    return { jid: padrao, existe: null, motivo: e.message };
  }
}

// Gera o ID da mensagem no mesmo formato do WhatsApp (3EB0 + 32 hex).
// Gerar o ID do NOSSO lado é o que permite repetir uma tentativa sem duplicar:
// a repetição usa o MESMO id, e o WhatsApp descarta a segunda via.
function novaIdMensagem() {
  return "3EB0" + crypto.randomBytes(16).toString("hex").toUpperCase();
}

// Erros que valem uma nova tentativa. Erro de número inexistente NÃO entra aqui.
function ehErroTemporario(mensagem) {
  const t = String(mensagem || "").toLowerCase();
  return (
    t.indexOf("timeout") !== -1 ||
    t.indexOf("excedeu o tempo limite") !== -1 ||
    t.indexOf("connection") !== -1 ||
    t.indexOf("closed") !== -1 ||
    t.indexOf("econnreset") !== -1 ||
    t.indexOf("epipe") !== -1 ||
    t.indexOf("unavailable") !== -1 ||
    t.indexOf("rate-overlimit") !== -1 ||
    t.indexOf("429") !== -1 ||
    t.indexOf("stream errored") !== -1
  );
}

// Envio único e definitivo. Devolve o ID real usado.
// opts: { messageId, registroId (linha em whatsapp_mensagens), tentativas }
async function sendText(jid, texto, opts) {
  const config = opts || {};
  const messageId = config.messageId || novaIdMensagem();
  const maxTentativas = config.tentativas == null ? 2 : config.tentativas;
  let ultimoErro = "Erro desconhecido";

  for (let tentativa = 0; tentativa <= maxTentativas; tentativa += 1) {
    if (!runtime.sock || runtime.status !== "connected") {
      const erro = "WhatsApp não conectado";
      await atualizarEnvio(config.registroId, { status: "falhou", erro: erro });
      runtime.messagesFailed += 1;
      return { ok: false, error: erro, messageId: messageId };
    }
    try {
      // Sem sendPresenceUpdate: modo somente envio não precisa sinalizar
      // "digitando" para o cliente, e isso reduz tráfego desnecessário
      // (um contato que recebe "digitando" e nunca recebe a mensagem é
      // justamente o que fica no balão).
      const enviada = await withTimeout(
        runtime.sock.sendMessage(jid, { text: String(texto) }, { messageId: messageId }),
        30000,
        "Envio"
      );
      const idFinal =
        enviada && enviada.key && enviada.key.id ? String(enviada.key.id) : messageId;
      const corpo =
        enviada && enviada.message ? enviada.message : { conversation: String(texto) };

      // Guarda no cache em DISCO usando todos os ids possíveis, para que o
      // pedido de reenvio do cliente sempre encontre a original.
      rememberSent(idFinal, corpo, jid);
      if (idFinal !== messageId) rememberSent(messageId, corpo, jid);

      runtime.messagesSent += 1;
      await atualizarEnvio(config.registroId, {
        status: "enviado",
        erro: null,
        mensagem_id_wpp: idFinal,
      });
      return { ok: true, messageId: idFinal, jid: jid };
    } catch (err) {
      ultimoErro = err && err.message ? err.message : String(err);
      const podeRepetir = tentativa < maxTentativas && ehErroTemporario(ultimoErro);
      if (!podeRepetir) break;
      log(
        "Envio falhou por motivo temporário (" +
          ultimoErro +
          "). Nova tentativa " +
          (tentativa + 1) +
          " de " +
          maxTentativas +
          " com o mesmo ID (não duplica)."
      );
      await new Promise((r) => setTimeout(r, 2500 * (tentativa + 1)));
    }
  }

  runtime.messagesFailed += 1;
  await atualizarEnvio(config.registroId, { status: "falhou", erro: ultimoErro });
  return { ok: false, error: ultimoErro, messageId: messageId };
}

// Envia para um número, validando antes.
async function sendToPhone(phone, texto, opts) {
  const check = validarNumero(phone);
  if (!check.ok) return { ok: false, error: check.motivo, messageId: null };
  const destino = await resolveJid(check.numero);
  if (destino.existe === false) {
    return { ok: false, error: "Número não possui WhatsApp", messageId: null };
  }
  const resultado = await sendText(destino.jid, texto, opts);
  return Object.assign({}, resultado, { jid: destino.jid });
}

// ───────────────────────────── Conexão ─────────────────────────────
async function onConnectionUpdate(update) {
  const { connection, qr, lastDisconnect } = update;

  if (qr) {
    runtime.status = "waiting_qr";
    try {
      runtime.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
    } catch (e) {
      runtime.qr = qr;
    }
    setError(null);
  }

  if (connection === "open") {
    runtime.status = "connected";
    runtime.qr = null;
    runtime.attempts = 0;
    runtime.connectedAt = Date.now();
    setError(null);
    const user = runtime.sock && runtime.sock.user;
    runtime.me = user ? { id: user.id || "", name: user.name || user.verifiedName || "" } : null;
    log("WhatsApp conectado", runtime.me ? "(" + runtime.me.id + ")" : "");
    // Aproveita a conexão para recuperar cobrança do dia que tenha sido perdida.
    setTimeout(() => {
      runDailyCobranca("recuperacao").catch(() => {});
    }, 15000);
  }

  if (connection === "close") {
    const code =
      lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode
        : null;
    runtime.status = "disconnected";
    runtime.qr = null;
    runtime.me = null;
    log("Conexão encerrada. Código:", code);

    if (code === DisconnectReason.loggedOut) {
      clearAuthDir();
      setError("A sessão foi encerrada no celular. Clique em Conectar e escaneie o QR Code novamente.");
      return;
    }
    if (code === DisconnectReason.connectionReplaced) {
      setError("Outra conexão assumiu este número do WhatsApp. Feche a outra sessão e conecte novamente.");
      return;
    }
    if (runtime.manualStop) return;

    // Sem sessão salva o QR expirou: esperar o usuário clicar em Conectar.
    if (!credsExist()) {
      setError("O QR Code expirou. Clique em Conectar WhatsApp para gerar um novo.");
      return;
    }
    if (runtime.attempts >= MAX_RECONNECT) {
      setError("Não foi possível reconectar automaticamente. Clique em Conectar WhatsApp.");
      return;
    }

    runtime.attempts += 1;
    runtime.reconnects += 1;
    const delay = Math.min(3000 * runtime.attempts, 30000);
    log("Reconectando em " + Math.round(delay / 1000) + "s (tentativa " + runtime.attempts + ")");
    setTimeout(() => {
      if (!runtime.manualStop) connect();
    }, delay);
  }
}

// ───────────── MENSAGENS RECEBIDAS — BLOQUEADAS POR DESIGN (v5.5.0) ─────────────
// Aqui ficava o atendimento por IA: cada mensagem do cliente era aberta, o texto
// era extraído, mandado para a OpenAI e a resposta era devolvida pelo WhatsApp.
// Esse comportamento foi DESATIVADO. Este servidor não é chatbot nem atendente:
// ele só ENVIA notificações.
//
// O que NÃO existe mais nesta versão:
//   • extractText()             → não abre o conteúdo de mensagem recebida
//   • handleIncomingMessage()   → não interpreta, não responde, não transfere
//   • resposta automática / boas-vindas por WhatsApp
//   • chamada da IA disparada por mensagem recebida
//
// O que resta é um contador. Ele não olha conteúdo nem remetente: só soma a
// quantidade para o painel mostrar "chegou algo neste período". É o mínimo para
// diagnóstico, sem ler conversa de ninguém e sem enviar nada de volta.
async function onMessagesUpsert(payload) {
  if (MODO_ENVIO_ONLY) {
    if (!payload || payload.type !== "notify") return;
    const quantidade = Array.isArray(payload.messages) ? payload.messages.length : 0;
    if (quantidade === 0) return;
    runtime.messagesReceived += quantidade;
    runtime.lastMessageAt = Date.now();
    // Nenhum conteúdo é lido. Nenhuma resposta é enviada.
    return;
  }
  // Modo atendimento (WPP_MODO=atendimento) mantido apenas para não quebrar
  // quem dependia dele. O padrão de fábrica é somente envio.
  if (!payload || payload.type !== "notify") return;
  const quantidade = Array.isArray(payload.messages) ? payload.messages.length : 0;
  if (quantidade === 0) return;
  runtime.messagesReceived += quantidade;
  runtime.lastMessageAt = Date.now();
}

// ───────────── COMPROVANTE DE ENTREGA (messages.update) ─────────────
// Isto NÃO é leitura de conversa: são os recibos técnicos que o WhatsApp devolve
// sobre as mensagens que NÓS enviamos (0 falhou, 1 pendente, 2 aceita pelo
// servidor, 3 entregue no aparelho, 4 lida). Sem isso, "enviado" no painel
// significaria apenas "o WhatsApp aceitou o pacote" — não que o cliente recebeu.
async function onMessagesUpdate(updates) {
  const lista = Array.isArray(updates) ? updates : [];
  for (const item of lista) {
    try {
      const id = item && item.key && item.key.id ? String(item.key.id) : "";
      if (!id) continue;
      const codigo =
        item.update && item.update.status != null ? Number(item.update.status) : null;
      if (codigo == null || isNaN(codigo)) continue;
      const status = STATUS_ENTREGA[codigo];
      if (!status) continue;
      if (status === "entregue") runtime.messagesDelivered += 1;
      if (status === "lido") runtime.messagesRead += 1;
      if (status === "falhou") runtime.messagesFailed += 1;
      await registrarEntrega(id, status);
    } catch (e) {
      /* um recibo com problema não pode derrubar a conexão */
    }
  }
}

async function connect() {
  if (runtime.starting) {
    log("Conexão já em andamento, ignorando chamada duplicada.");
    return;
  }
  runtime.starting = true;
  runtime.manualStop = false;
  setError(null);
  runtime.status = "connecting";

  try {
    if (runtime.sock) {
      try {
        runtime.sock.end(undefined);
      } catch (e) {
        /* ignora */
      }
      runtime.sock = null;
    }

    const authState = await useMultiFileAuthState(AUTH_DIR);
    let version;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch (e) {
      version = undefined;
    }

    const sock = makeWASocket({
      version: version,
      auth: {
        creds: authState.state.creds,
        keys: makeCacheableSignalKeyStore(authState.state.keys, logger),
      },
      logger: logger,
      printQRInTerminal: false,
      browser: Browsers.ubuntu("Chrome"),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      msgRetryCounterCache: createTinyCache(),
      // ─── FIX CENTRAL DO BALÃO "AGUARDANDO MENSAGEM" ───
      // Quando o aparelho do cliente recebe uma mensagem e não consegue abrir,
      // o WhatsApp dele pede de volta o conteúdo original. Este handler é quem
      // responde esse pedido. Regras:
      //   • devolver a mensagem ORIGINAL e completa (nunca vazia);
      //   • nunca devolver { conversation: "" } — era exatamente isso que
      //     deixava o cliente travado no balão cinza com o relógio;
      //   • quando não há cache, devolver undefined (o WhatsApp não entrega
      //     envelope fantasma) e registrar no log para diagnóstico.
      getMessage: async (key) => {
        const id = key && key.id ? String(key.id) : "";
        const original = getSentMessage(id);
        if (!original) {
          log("Pedido de reenvio sem cache para " + (id || "(sem id)"));
          return undefined;
        }
        return original;
      },
    });

    runtime.sock = sock;
    sock.ev.on("creds.update", authState.saveCreds);
    sock.ev.on("connection.update", (update) => {
      onConnectionUpdate(update).catch((err) => {
        console.error(LOG_PREFIX, "Erro em connection.update:", err.message);
      });
    });
    // Só conta que chegou algo. Não abre, não interpreta, não responde.
    sock.ev.on("messages.upsert", (payload) => {
      onMessagesUpsert(payload).catch((err) => {
        console.error(LOG_PREFIX, "Erro em messages.upsert:", err.message);
      });
    });
    // Recibos técnicos das mensagens que NÓS enviamos (enviado/entregue/lido).
    sock.ev.on("messages.update", (updates) => {
      onMessagesUpdate(updates).catch((err) => {
        console.error(LOG_PREFIX, "Erro em messages.update:", err.message);
      });
    });

    log("Socket iniciado. Sessão salva:", credsExist() ? "sim" : "não");
  } catch (err) {
    runtime.status = "disconnected";
    setError("Falha ao iniciar a conexão: " + err.message);
    console.error(LOG_PREFIX, "Erro ao iniciar conexão:", err.message);
  } finally {
    runtime.starting = false;
  }
}

async function disconnect() {
  runtime.manualStop = true;
  runtime.attempts = 0;
  try {
    if (runtime.sock) runtime.sock.end(undefined);
  } catch (e) {
    /* ignora */
  }
  runtime.sock = null;
  runtime.status = "disconnected";
  runtime.qr = null;
  runtime.me = null;
  log("Desconectado manualmente");
}

// Remove o vínculo no celular e apaga a sessão salva (conectar do zero).
async function resetSession() {
  runtime.manualStop = true;
  try {
    if (runtime.sock) {
      try {
        await withTimeout(runtime.sock.logout(), 10000, "Logout");
      } catch (e) {
        /* segue limpando */
      }
      try {
        runtime.sock.end(undefined);
      } catch (e) {
        /* ignora */
      }
    }
  } catch (e) {
    /* ignora */
  }
  runtime.sock = null;
  clearAuthDir();
  runtime.status = "disconnected";
  runtime.qr = null;
  runtime.me = null;
  runtime.attempts = 0;
  runtime.starting = false;
  runtime.manualStop = false;
  setError(null);
  await connect();
}

// ───────────────────────────── Cobrança / confirmações ─────────────────────────────
function buildMessageTemplate(daysDiff, nome, valor, link) {
  const v = formatCurrency(valor);
  const app = link || "https://kairostempodedeus.com/cliente";
  if (daysDiff < 0) {
    const d = Math.abs(daysDiff);
    return (
      "⚠️ Olá, " + nome + "! Tudo bem? 😊\n\n" +
      "Percebemos que sua parcela de " + v + " venceu há " + d + (d === 1 ? " dia" : " dias") + " 📅.\n\n" +
      "Para regularizar sua situação e manter sua linha de crédito ativa 💙, realize o pagamento o quanto antes.\n\n" +
      "📱 Aplicativo: 🔗 " + app + "\n\n💙 Loja Kairós"
    );
  }
  if (daysDiff === 0) {
    return (
      "📢 Olá, " + nome + "! Tudo bem? 😊\n\n" +
      "Sua parcela de " + v + " vence hoje 📝💳✨. Pague hoje para evitar juros e manter seu bom histórico.\n\n" +
      "🔗 " + app + "\n\nKairós Crédito 💙🚀"
    );
  }
  if (daysDiff === 1) {
    return (
      "🌟 Olá, " + nome + "! Sua parcela de " + v + " vence amanhã 📅. Mensagem automática para ajudar na sua organização.\n\n" +
      "🔗 " + app + "\n\n💙 Loja Kairós"
    );
  }
  return (
    "🌟 Olá, " + nome + "! Sua parcela de " + v + " vence em " + daysDiff + " dias 📅. Mensagem automática para ajudar na sua organização.\n\n" +
    "🔗 " + app + "\n\n💙 Loja Kairós"
  );
}

function buildMessage(nome, valor, vencimento, link) {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const venc = new Date(String(vencimento || "").slice(0, 10) + "T00:00:00");
  const diff = isNaN(venc.getTime()) ? 0 : Math.round((venc - hoje) / 86400000);
  return buildMessageTemplate(diff, nome, valor, link);
}

// Grava o histórico de envio e devolve o id da linha criada.
// O id é usado para atualizar a MESMA linha depois (enviado -> entregue -> lido),
// em vez de criar uma linha nova a cada evento — que era o que bagunçava o painel.
async function saveMessageRecord(rec) {
  try {
    const res = await callAgent({
      acao: "salvar_mensagem",
      registro: {
        client_id: rec.client_id || null,
        parcela_id: rec.parcela_id || null,
        cliente_nome: rec.cliente_nome,
        whatsapp: rec.whatsapp,
        mensagem: rec.mensagem,
        status: rec.status,
        erro: rec.erro || null,
        tipo: rec.tipo || "manual",
        mensagem_id_wpp: rec.mensagem_id_wpp || null,
      },
    });
    if (!res || res.ok !== true) {
      console.error(LOG_PREFIX, "Não foi possível salvar o histórico de mensagem.");
      return null;
    }
    return res.id || null;
  } catch (e) {
    console.error(LOG_PREFIX, "Erro ao salvar histórico de mensagem:", e.message);
    return null;
  }
}

const DEFAULT_CONFIRMACAO =
  "✅ Olá, {nome}! Pagamento confirmado com sucesso! 💙\n\n" +
  "📄 Parcela: {parcela} de {produto}\n" +
  "💰 Valor: {valor}\n" +
  "📅 Data do pagamento: {data}\n\n" +
  "Agradecemos pela sua confiança! Continuamos à disposição. 🙌\n\n" +
  "💙 {empresa}";

function fillTokens(template, map) {
  let out = String(template || "");
  Object.keys(map).forEach((key) => {
    out = out.split("{" + key + "}").join(String(map[key] == null ? "" : map[key]));
  });
  return out;
}

let confirmRunning = false;
let confirmStartedAt = 0;
const confirmFailCount = {};

async function sendPaymentConfirmations() {
  if (runtime.status !== "connected" || !runtime.sock) return;
  if (confirmRunning) {
    if (confirmStartedAt && Date.now() - confirmStartedAt > 120000) {
      confirmRunning = false;
    } else {
      return;
    }
  }
  confirmRunning = true;
  confirmStartedAt = Date.now();

  try {
    // MARCO DE INÍCIO: a função wpp-agente aplica o campo iniciar_em da
    // configuração. Nada é enviado para pagamentos ANTERIORES ao momento em
    // que a confirmação foi ativada — só o que o cliente pagar daqui pra frente.
    const desde = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const lote = await callAgent({ acao: "confirmacao_lote", desde });
    if (!lote || lote.ok !== true) {
      if (lote && lote.erro) console.error(LOG_PREFIX, "Confirmações:", lote.erro);
      return;
    }

    const cfg = lote.config;
    if (cfg && cfg.ativo === false) return;
    const template = (cfg && cfg.mensagem) || DEFAULT_CONFIRMACAO;

    const parcelas = Array.isArray(lote.parcelas) ? lote.parcelas : [];
    if (parcelas.length === 0) return;

    for (const p of parcelas) {
      const client = p.cliente || null;
      if (!client || !client.whatsapp) continue;

      // Reserva atômica: a mesma parcela nunca é avisada duas vezes.
      const claim = await callAgent({ acao: "confirmacao_marcar", parcela_id: p.id });
      if (!claim || claim.ok !== true) continue;

      const phone = normalizeNumber(client.whatsapp);
      const nome = client.full_name || "Cliente";
      const dataPago = p.data_pagamento || (p.pago_em ? String(p.pago_em).slice(0, 10) : "");
      const carne = p.carne || null;
      const mensagem = fillTokens(template, {
        nome: nome,
        valor: formatCurrency(p.valor),
        parcela: p.numero,
        produto: (carne && carne.product_name) || "Carnê",
        data: dataPago ? formatDateBR(dataPago) : "",
        link: (carne && carne.link) || "",
        empresa: "Kairós",
      });

      // Registra ANTES de enviar, como pendente. Assim a linha já existe quando
      // o comprovante de entrega chegar — e o painel nunca mostra "enviado"
      // para algo que não saiu de verdade.
      const registroId = await saveMessageRecord({
        client_id: client.id,
        parcela_id: p.id,
        cliente_nome: nome,
        whatsapp: phone,
        mensagem: mensagem,
        status: "pendente",
        tipo: "confirmacao",
      });

      const resultado = await sendToPhone(phone, mensagem, { registroId: registroId });

      if (resultado.ok) {
        delete confirmFailCount[p.id];
        log("Confirmação enviada para", nome, "(id", resultado.messageId + ")");
      } else {
        confirmFailCount[p.id] = (confirmFailCount[p.id] || 0) + 1;
        const tentativas = confirmFailCount[p.id];
        // Devolve a parcela para a fila até 5 tentativas. Depois desiste e mantém
        // registrado como falha, para não virar loop infinito de erro.
        if (tentativas < 5) {
          await callAgent({ acao: "confirmacao_desmarcar", parcela_id: p.id });
        }
        log("Confirmação falhou para " + nome + ": " + resultado.error);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (err) {
    console.error(LOG_PREFIX, "Erro na varredura de confirmações:", err.message);
  } finally {
    confirmRunning = false;
    confirmStartedAt = 0;
  }
}

// Envia a cobrança do dia. Protegida por estado em disco para NÃO repetir
// quando o serviço reinicia (deploy, queda, troca de hospedagem).
let cobrancaRunning = false;
async function runDailyCobranca(origem) {
  const hoje = todayBRT();
  if (cobrancaRunning) return;
  if (runtime.status !== "connected" || !runtime.sock) {
    log("[COBRANCA] Ignorada (" + origem + "): WhatsApp não conectado.");
    return;
  }
  if (readState().lastCobrancaDate === hoje) {
    log("[COBRANCA] Já executada hoje (" + hoje + "). Nada a fazer.");
    return;
  }

  cobrancaRunning = true;
  // Marca antes de enviar: garante que um reinício no meio não duplique mensagens.
  writeState({ lastCobrancaDate: hoje, lastCobrancaAt: new Date().toISOString(), lastCobrancaOrigem: origem });

  try {
    log("[COBRANCA] Iniciando envio do dia (" + origem + ")...");
    const lote = await callAgent({ acao: "cobranca_lote", hoje });
    if (!lote || lote.ok !== true) {
      if (lote && lote.erro) console.error(LOG_PREFIX, "[COBRANCA] Banco:", lote.erro);
      // Libera a data para tentar de novo na próxima checagem.
      writeState({ lastCobrancaDate: null });
      return;
    }

    const parcelas = Array.isArray(lote.parcelas) ? lote.parcelas : [];
    if (parcelas.length === 0) return;

    let enviados = 0;
    for (const p of parcelas) {
      const client = p.cliente || null;
      if (!client || !client.whatsapp) continue;
      const carne = p.carne || null;
      const phone = normalizeNumber(client.whatsapp);
      const mensagem = buildMessage(client.full_name || "Cliente", p.valor, p.vencimento, (carne && carne.link) || "");
      const registroId = await saveMessageRecord({
        client_id: client.id,
        parcela_id: p.id,
        cliente_nome: client.full_name,
        whatsapp: phone,
        mensagem: mensagem,
        status: "pendente",
        tipo: "automatico",
      });
      const resultado = await sendToPhone(phone, mensagem, { registroId: registroId });
      if (resultado.ok) enviados += 1;
      await new Promise((r) => setTimeout(r, 2000));
    }
    writeState({ lastCobrancaEnviados: enviados });
    log("[COBRANCA] Finalizada. Enviadas: " + enviados + " de " + parcelas.length + ".");
  } catch (err) {
    console.error(LOG_PREFIX, "[COBRANCA] Erro:", err.message);
  } finally {
    cobrancaRunning = false;
  }
}

// Envia as mensagens que os atendentes humanos escrevem no painel.
// A fila vem do agente de IA, porque o servidor não tem permissão de leitura
// nessas tabelas — era isso que deixava as respostas presas em "pendente".
let pendingRunning = false;
async function sendPendingHumanMessages() {
  if (runtime.status !== "connected" || !runtime.sock || pendingRunning) return;
  pendingRunning = true;
  try {
    const fila = await callAgent({ acao: "pendentes", limite: 15 });
    const mensagens = (fila && Array.isArray(fila.mensagens)) ? fila.mensagens : [];
    if (mensagens.length === 0) return;

    for (const m of mensagens) {
      const resultado = await sendToPhone(m.whatsapp, m.mensagem);
      await confirmMessageStatus(m.id, resultado.ok ? "enviado" : "falhou", resultado.error);
      if (resultado.ok) runtime.humanSent += 1;
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (err) {
    console.error(LOG_PREFIX, "Erro ao enviar mensagens humanas:", err.message);
  } finally {
    pendingRunning = false;
  }
}

// ───────────────────────────── Rotas ─────────────────────────────
function checkAuth(req, res, next) {
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// v5.3.0 — a permissão do banco não depende mais de nenhuma chave no servidor:
// quem executa as consultas é a função wpp-agente, com permissão total.
function permissoesBanco() {
  if (dbHealth.status === "ok") return "completa";
  if (String(dbHealth.status).indexOf("erro") === 0) return "limitada";
  return "verificando";
}

function statusPayload() {
  const state = readState();
  return {
    status: runtime.status,
    qr: runtime.qr,
    last_error: runtime.lastError,
    engine: "baileys",
    server_version: SERVER_VERSION,
    platform: PLATFORM,
    registered: isRegistered() || credsExist(),
    uptime: Math.round(process.uptime()),
    me: runtime.me,
    connected_at: runtime.connectedAt,
    last_message_at: runtime.lastMessageAt,
    messages_received: runtime.messagesReceived,
    messages_sent: runtime.messagesSent,
    messages_delivered: runtime.messagesDelivered,
    messages_read: runtime.messagesRead,
    messages_failed: runtime.messagesFailed,
    human_sent: runtime.humanSent,
    modo: MODO_ENVIO_ONLY ? "somente_envio" : "atendimento",
    baileys_version: versaoBaileys(),
    baileys_desatualizado: baileysAntigo(),
    cache_envio: contarCacheEnvio(),
    conflito_instancias: conflitoInstancias(),
    reconnectAttempts: runtime.attempts,
    maxReconnect: MAX_RECONNECT,
    reconnects: runtime.reconnects,
    auth_dir: AUTH_DIR,
    auth_dir_origem: AUTH_DETECT.origem,
    auth_persistente: AUTH_PERSISTENT,
    volume_ok: credsExist(),
    db_key: "agente",
    last_cobranca: state.lastCobrancaDate || null,
    last_cobranca_at: state.lastCobrancaAt || null,
    conversas_ativas: listarArquivosSessao().length,
    realinhamento_em: state.lastRealinhamentoAt || null,
    realinhamento_qtd: state.lastRealinhamentoQtd == null ? null : state.lastRealinhamentoQtd,
    today: todayBRT(),
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Kairos WPP",
    version: SERVER_VERSION,
    engine: "baileys",
    platform: PLATFORM,
    status: runtime.status,
  });
});

// Saúde do banco fica em CACHE.
// IMPORTANTE: a verificação de saúde da hospedagem (Fly/Render) tem tempo
// limite. Se ela consultasse o banco a cada checagem, uma resposta lenta do
// banco estourava o limite, a máquina era considerada "doente", reiniciava,
// estourava de novo... e o site ficava fora do ar em loop ("Request failed").
// Por isso /api/health responde na hora, sem consultar nada externo.
const dbHealth = { status: "verificando", at: 0 };

async function probeDb() {
  try {
    const res = await withTimeout(callAgent({ acao: "probe" }), 8000, "Banco");
    if (!res) dbHealth.status = "offline";
    else dbHealth.status = res.ok ? "ok" : "erro: " + (res.erro || "sem resposta");
  } catch (e) {
    dbHealth.status = "offline";
  }
  dbHealth.at = Date.now();
  return dbHealth.status;
}

function healthPayload() {
  return {
    ok: true,
    version: SERVER_VERSION,
    platform: PLATFORM,
    status: runtime.status,
    uptime: Math.round(process.uptime()),
    registered: isRegistered() || credsExist(),
    volume_ok: credsExist(),
    auth_dir: AUTH_DIR,
    auth_persistente: AUTH_PERSISTENT,
    db: dbHealth.status,
    db_key: "agente",
    db_checked_at: dbHealth.at || null,
    last_cobranca: readState().lastCobrancaDate || null,
    today: todayBRT(),
  };
}

// Endpoint de monitoramento: responde SEMPRE na hora (é o que a hospedagem usa).
app.get("/api/health", (req, res) => {
  res.json(healthPayload());
});

// Diagnóstico profundo: consulta o banco de verdade. Usado pelo painel.
app.get("/api/health/deep", async (req, res) => {
  await probeDb();
  res.json(healthPayload());
});

app.get("/api/status", (req, res) => {
  res.json(statusPayload());
});

// Diagnóstico da configuração: diz em português o que está faltando.
// Não expõe nenhum valor de chave, só informa se cada uma está presente.
app.get("/api/diagnostico", (req, res) => {
  const avisos = [];
  if (!AUTH_PERSISTENT) {
    avisos.push(
      "A pasta da sessão não está em um disco persistente (" + AUTH_DIR + "). O WhatsApp vai pedir QR Code de novo a cada reinício. Crie um disco e monte em /var/data (no Render isso já vem no render.yaml)."
    );
  }
  if (baileysAntigo()) {
    avisos.push(
      "A biblioteca do WhatsApp está na versão " +
        versaoBaileys() +
        ", anterior ao suporte a LID (6.7.18+). É a principal causa do balão \"Aguardando mensagem\" no celular do cliente. Atualize com: npm install @whiskeysockets/baileys@6.7.20"
    );
  }
  const outra = conflitoInstancias();
  if (outra) {
    avisos.push(
      "Existe OUTRO serviço usando a mesma pasta de sessão (PID " +
        outra.pid +
        ", host " +
        (outra.host || "?") +
        "). Dois processos na mesma sessão corrompem as chaves e causam o balão \"Aguardando mensagem\". Deixe só um serviço apontando para este disco."
    );
  }
  if (MODO_ENVIO_ONLY) {
    avisos.push(
      "Modo SOMENTE ENVIO ativo: o servidor não lê, não interpreta e não responde mensagens recebidas. Ele apenas envia notificações e registra o comprovante de entrega."
    );
  }
  res.json({
    ok: avisos.length === 0 || MODO_ENVIO_ONLY,
    versao: SERVER_VERSION,
    modo: MODO_ENVIO_ONLY ? "somente_envio" : "atendimento",
    baileys_version: versaoBaileys(),
    baileys_atualizado: !baileysAntigo(),
    plataforma: PLATFORM,
    url_publica: PUBLIC_URL || "(não detectada)",
    pasta_da_sessao: AUTH_DIR,
    pasta_origem: AUTH_DETECT.origem,
    pasta_persistente: AUTH_PERSISTENT,
    sessao_salva: credsExist(),
    cache_envio_mensagens: contarCacheEnvio(),
    instancia_conflitante: conflitoInstancias(),
    permissoes_banco: permissoesBanco(),
    chaves_com_padrao: {
      WPP_API_KEY: !process.env.WPP_API_KEY,
      WPP_AGENT_SECRET: !process.env.WPP_AGENT_SECRET,
      SUPABASE_URL: !process.env.SUPABASE_URL,
    },
    avisos: avisos,
  });
});

app.post("/api/connect", checkAuth, async (req, res) => {
  runtime.attempts = 0;
  runtime.manualStop = false;
  await connect();
  res.json({ success: true, message: "Iniciando conexão..." });
});

app.post("/api/disconnect", checkAuth, async (req, res) => {
  await disconnect();
  res.json({ success: true, message: "WhatsApp desconectado" });
});

// Realinha as chaves de conversa SEM apagar a sessão (não pede QR Code).
// É o botão que resolve o balão "Aguardando mensagem" no celular do cliente.
app.post("/api/realinhar", checkAuth, async (req, res) => {
  const resultado = await realinharCriptografia();
  if (!resultado.ok) {
    return res.status(400).json({ success: false, error: resultado.erro });
  }
  res.json({
    success: true,
    sessoes_renovadas: resultado.sessoes,
    message:
      "Chaves de conversa renovadas. Nenhum QR Code é necessário e a conexão continua a mesma.",
  });
});

app.post("/api/reset", checkAuth, async (req, res) => {
  const limpo = clearAuthDir();
  await resetSession();
  res.json({
    success: true,
    message: limpo
      ? "Sessão apagada. Escaneie o novo QR Code."
      : "Sessão não pôde ser apagada do disco. Tente novamente.",
  });
});

app.post("/api/send", checkAuth, async (req, res) => {
  const body = req.body || {};
  if (!body.whatsapp) return res.status(400).json({ success: false, error: "whatsapp é obrigatório" });
  if (runtime.status !== "connected" || !runtime.sock) {
    return res.status(400).json({ success: false, error: "WhatsApp não conectado" });
  }

  const check = validarNumero(body.whatsapp);
  if (!check.ok) return res.status(400).json({ success: false, error: check.motivo });

  const phone = check.numero;
  const nome = body.nome || "Cliente";
  const mensagem = body.mensagem || buildMessage(nome, body.valor, body.vencimento, body.link);

  const registroId = await saveMessageRecord({
    client_id: body.client_id,
    parcela_id: body.parcela_id,
    cliente_nome: nome,
    whatsapp: phone,
    mensagem: mensagem,
    status: "pendente",
    tipo: "manual",
  });

  const resultado = await sendToPhone(phone, mensagem, { registroId: registroId });
  if (!resultado.ok) return res.status(400).json({ success: false, error: resultado.error });
  res.json({
    success: true,
    message: "Enviado!",
    mensagem_id_wpp: resultado.messageId,
    registro_id: registroId,
  });
});

app.post("/api/send-bulk", checkAuth, async (req, res) => {
  const clientes = (req.body && req.body.clientes) || [];
  if (!Array.isArray(clientes) || clientes.length === 0) {
    return res.status(400).json({ success: false, error: "Lista vazia" });
  }
  if (runtime.status !== "connected" || !runtime.sock) {
    return res.status(400).json({ success: false, error: "WhatsApp não conectado" });
  }

  let enviados = 0;
  let falhas = 0;
  for (const c of clientes) {
    const check = validarNumero(c.whatsapp);
    if (!check.ok) {
      falhas += 1;
      await saveMessageRecord({
        client_id: c.client_id,
        parcela_id: c.parcela_id,
        cliente_nome: c.nome || "Cliente",
        whatsapp: normalizeNumber(c.whatsapp),
        mensagem: c.mensagem || "(não enviado)",
        status: "falhou",
        erro: check.motivo,
        tipo: "manual",
      });
      continue;
    }
    const phone = check.numero;
    const nome = c.nome || "Cliente";
    const mensagem = c.mensagem || buildMessage(nome, c.valor, c.vencimento, c.link);
    const registroId = await saveMessageRecord({
      client_id: c.client_id,
      parcela_id: c.parcela_id,
      cliente_nome: nome,
      whatsapp: phone,
      mensagem: mensagem,
      status: "pendente",
      tipo: "manual",
    });
    const resultado = await sendToPhone(phone, mensagem, { registroId: registroId });
    if (resultado.ok) enviados += 1;
    else falhas += 1;
    await new Promise((r) => setTimeout(r, 2000));
  }

  res.json({ success: true, total: clientes.length, enviados: enviados, falhas: falhas });
});

app.post("/api/sweep-confirmacoes", checkAuth, async (req, res) => {
  if (runtime.status !== "connected" || !runtime.sock) {
    return res.status(400).json({ success: false, error: "WhatsApp não conectado" });
  }
  await sendPaymentConfirmations();
  res.json({ success: true, message: "Verificação executada." });
});

// Consulta se um número tem WhatsApp, sem enviar nada.
// Serve para você conferir o número antes de mandar o teste.
app.post("/api/verificar-numero", checkAuth, async (req, res) => {
  const check = validarNumero((req.body && req.body.whatsapp) || "");
  if (!check.ok) return res.status(400).json({ success: false, error: check.motivo });
  const destino = await resolveJid(check.numero);
  res.json({
    success: true,
    numero: check.numero,
    existe: destino.existe,
    jid: destino.jid,
    lid: destino.lid || null,
    observacao: destino.motivo || null,
  });
});

// Envia uma mensagem de teste de verdade para o número informado.
// Usa o MESMO caminho do envio automático (validação -> JID -> cache -> retry),
// então se o teste chegar, o caminho do cliente também está certo.
// Devolve o ID real da mensagem no WhatsApp — é o comprovante técnico.
app.post("/api/test", checkAuth, async (req, res) => {
  const body = req.body || {};
  const check = validarNumero(body.whatsapp || "");
  if (!check.ok) return res.status(400).json({ success: false, error: check.motivo });
  if (runtime.status !== "connected" || !runtime.sock) {
    return res.status(400).json({ success: false, error: "WhatsApp não conectado" });
  }

  const personalizada = String(body.mensagem || "").trim();
  const texto =
    personalizada ||
    "✅ Teste do painel Kairós: seu WhatsApp está conectado e enviando mensagens corretamente.";

  const registroId = await saveMessageRecord({
    cliente_nome: "Teste do painel",
    whatsapp: check.numero,
    mensagem: texto,
    status: "pendente",
    tipo: "teste",
  });

  const resultado = await sendToPhone(check.numero, texto, { registroId: registroId });
  if (!resultado.ok) return res.status(400).json({ success: false, error: resultado.error });

  res.json({
    success: true,
    message: "Mensagem de teste enviada!",
    numero: check.numero,
    jid: resultado.jid,
    mensagem_id_wpp: resultado.messageId,
    registro_id: registroId,
  });
});

// ───────────────────────────── Tarefas periódicas ─────────────────────────────
// Cobrança automática diária: 11:00 no horário de Brasília.
cron.schedule(
  "0 " + HORA_COBRANCA + " * * *",
  () => {
    runDailyCobranca("agendamento").catch(() => {});
  },
  { timezone: "America/Sao_Paulo" }
);

setInterval(sendPendingHumanMessages, 5000);
setInterval(sendPaymentConfirmations, 8000);
// Mantém o diagnóstico de banco atualizado (o /api/health só devolve o cache).
setInterval(() => {
  probeDb().catch(() => {});
}, 60000);

// Batimento da instância + limpeza do cache de envio (a cada 30s / 1h).
setInterval(escreverLock, 30000);
setInterval(() => {
  const removidos = cleanupSentCache();
  if (removidos > 0) log("Cache de envio: " + removidos + " arquivo(s) antigo(s) removido(s).");
}, 60 * 60 * 1000);

// Rede de segurança: de hora em hora confere se a cobrança do dia saiu.
// Cobre o caso de o serviço estar reiniciando exatamente no horário marcado.
setInterval(() => {
  const agora = minutesNowBRT();
  if (agora >= HORA_COBRANCA * 60) {
    runDailyCobranca("verificacao_horaria").catch(() => {});
  }
}, 60 * 60 * 1000);

// Mantém o serviço acordado. Em hospedagens "always-on" isso é dispensável,
// mas não custa nada e protege contra planos que hibernam por inatividade.
if (PUBLIC_URL) {
  setInterval(() => {
    fetch(PUBLIC_URL.replace(/\/+$/, "") + "/api/health").catch(() => {
      /* ignora */
    });
  }, 2 * 60 * 1000);
  log("Keep-alive ativo:", PUBLIC_URL);
} else {
  log("Keep-alive inativo (sem URL pública detectada). Defina WPP_PUBLIC_URL se precisar.");
}

// Desligamento limpo: salva a sessão antes de morrer. Sem isso, um deploy
// poderia corromper o arquivo de credenciais e derrubar a conexão.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("Recebido " + signal + ". Encerrando com segurança...");
  runtime.manualStop = true;
  try {
    if (runtime.sock) runtime.sock.end(undefined);
  } catch (e) {
    /* ignora */
  }
  writeState({ lastShutdown: new Date().toISOString(), lastShutdownSignal: signal });
  setTimeout(() => process.exit(0), 1500);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Rede de segurança: escuta também nas portas alternativas (8080/3001).
// Assim a checagem de saúde da hospedagem acerta a porta em qualquer cenário.
FALLBACK_PORTS.forEach((porta) => {
  try {
    const extra = app.listen(porta, "0.0.0.0", () => {
      log("Escutando também na porta " + porta + " (compatibilidade)");
    });
    extra.on("error", (err) => {
      log("Porta " + porta + " indisponível: " + err.message);
    });
  } catch (e) {
    /* ignora */
  }
});

app.listen(PORT, "0.0.0.0", () => {
  log("Servidor Kairós WPP v" + SERVER_VERSION + " na porta " + PORT);
  log("Plataforma:", PLATFORM);
  log("Pasta da sessão:", AUTH_DIR, "(" + AUTH_DETECT.origem + ")");
  log("Disco persistente:", AUTH_PERSISTENT ? "SIM" : "NÃO — a sessão será perdida a cada reinício!");
  log("Credenciais salvas:", credsExist() ? "sim" : "não (vai precisar de QR Code)");
  log("Banco: via função wpp-agente (permissão completa, sem chave secreta no servidor)");
  log("Biblioteca do WhatsApp:", versaoBaileys(), baileysAntigo() ? "(DESATUALIZADA — causa do balão!)" : "(ok)");
  log("Modo:", MODO_ENVIO_ONLY ? "SOMENTE ENVIO (não lê nem responde mensagens)" : "atendimento");

  // Trava de instância + limpeza do cache de envio na subida.
  escreverLock();
  const limpos = cleanupSentCache();
  log("Cache de envio:", contarCacheEnvio(), "mensagem(ns) guardada(s)", limpos ? "(" + limpos + " expirada(s) removida(s))" : "");
  const outra = conflitoInstancias();
  if (outra) {
    log("⚠ ATENÇÃO: outro processo (PID " + outra.pid + ") está usando esta mesma sessão. Isso corrompe as chaves de conversa.");
  }

  // Primeira checagem do banco em segundo plano (não trava a subida).
  probeDb().catch(() => {});

  // Só reconecta sozinho se já existe sessão salva. Sem sessão, o QR só é
  // gerado quando o administrador clica em "Conectar WhatsApp".
  if (credsExist()) {
    // v5.4.0 — primeira subida desta versão: renova as chaves de conversa uma
    // única vez. É isso que destrava o balão "Aguardando mensagem" que já
    // ficou preso nos celulares dos clientes com a sessão antiga.
    const estadoAtual = readState();
    if (estadoAtual.realinhamento !== REALIGN_MARK) {
      const removidos = limparSessoesDeConversa();
      writeState({
        realinhamento: REALIGN_MARK,
        lastRealinhamentoAt: new Date().toISOString(),
        lastRealinhamentoQtd: removidos,
      });
      log("Chaves de conversa renovadas automaticamente (" + removidos + " arquivos).");
    }
    runtime.manualStop = false;
    connect();
  }

  // Se o serviço estava fora do ar no horário da cobrança, recupera agora.
  setTimeout(() => {
    const agora = minutesNowBRT();
    if (agora >= HORA_COBRANCA * 60) {
      runDailyCobranca("inicializacao").catch(() => {});
    } else {
      log("[COBRANCA] Hoje ainda não passou do horário. Aguardando " + HORA_COBRANCA + ":00.");
    }
  }, 20000);
});