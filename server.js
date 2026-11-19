import http from "node:http";
import { getReservoirs } from "./reservoirs.js";
import { readFile } from "node:fs/promises";
import { readFileSync, mkdirSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { createHash, createHmac, randomInt, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
try {
  const envText = readFileSync(path.join(ROOT, ".env"), "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
} catch {}
const PORT = Number(process.env.PORT || 3000);
// A host can mount durable storage here without exposing it through static routes.
const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || ROOT);
if (STORAGE_DIR === PUBLIC || STORAGE_DIR.startsWith(PUBLIC + path.sep)) throw new Error("STORAGE_DIR must be outside public/.");
mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 });
const HOME_PAGE = process.env.HOME_PAGE === "atlas.html" ? "atlas.html" : "index.html";
const CACHE_MS = Math.max(60, Number(process.env.CACHE_SECONDS || 300)) * 1000;
const FEEDS = {
  warnings: process.env.IMD_WARNINGS_URL || "https://mausam.imd.gov.in/api/warnings_district_api.php",
  rainfall: process.env.IMD_RAINFALL_URL || "https://mausam.imd.gov.in/api/districtwise_rainfall_api.php",
};
const WEATHER_API_KEY = process.env.WEATHERAPI_KEY || "";
const WEATHER_CACHE_MS = Math.max(3600, Number(process.env.WEATHER_CACHE_SECONDS || 21600)) * 1000;
const WEATHER_DATA_VERSION = 2;
const WEATHER_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.WEATHER_CONCURRENCY || 5)));
const DISTRICT_CSV = path.join(ROOT, "data", "district_exposure.csv");
const WEATHER_CACHE_FILE = path.join(STORAGE_DIR, ".weather-cache.json");
const SMS_STORE_FILE = path.join(STORAGE_DIR, ".sms-subscribers.json");
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
const SMS_OTP_MAX_PER_HOUR = Math.max(1, Math.min(100, Number(process.env.SMS_OTP_MAX_PER_HOUR || 12)));
const SMS_CONFIGURED = Boolean(process.env.SMS_ENABLED !== "false" && /^AC[a-f0-9]{32}$/i.test(TWILIO_ACCOUNT_SID) && TWILIO_AUTH_TOKEN && /^\+[1-9]\d{7,14}$/.test(TWILIO_FROM_NUMBER) && /^https:\/\/[^/]+/.test(PUBLIC_BASE_URL) && WEATHER_API_KEY);

let cachedLive = null;
let cachedAt = 0;
let refreshInFlight = null;
let weatherRisk = { status: "idle", results: [], completed: 0, total: 0, failed: 0, generatedAt: null, error: null };
let weatherCacheLoaded = false;
let smsStore = [];
let smsStoreLoaded = false;
const smsOtpSentAt = [];
let weatherRefreshInFlight = null;
const requests = new Map();
const monitors = new Map();
const monitorFlights = new Map();
let atlasDistricts;
const contentTypes = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", ...headers });
  res.end(body);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
}

function allowRequest(req, res) {
  const now = Date.now();
  const ip = req.socket.remoteAddress || "unknown";
  const recent = (requests.get(ip) || []).filter(t => now - t < 60_000);
  if (recent.length >= 30) {
    json(res, 429, { error: "Refresh limit reached. Try again shortly." });
    return false;
  }
  recent.push(now);
  requests.set(ip, recent);
  return true;
}

async function fetchFeed(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "FloodWatch/1.0 (IMD district warning and rainfall display)" },
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`IMD returned HTTP ${response.status}`);
    let data;
    try { data = JSON.parse(body); }
    catch { throw new Error("IMD response was not JSON. Check the feed URL and IP allowlisting."); }
    return { ok: true, data, error: null };
  } catch (error) {
    const message = error?.name === "AbortError" ? "IMD request timed out." : (error?.message || "IMD request failed.");
    return { ok: false, data: null, error: message };
  } finally {
    clearTimeout(timeout);
  }
}

async function readLiveFeeds() {
  const [warnings, rainfall] = await Promise.all([fetchFeed(FEEDS.warnings), fetchFeed(FEEDS.rainfall)]);
  const result = { fetchedAt: new Date().toISOString(), warnings, rainfall };
  if (!warnings.ok && !rainfall.ok) result.error = "Both IMD feeds are unavailable. Check backend network access and IMD IP allowlisting.";
  cachedLive = result;
  cachedAt = Date.now();
  return result;
}

async function liveFeeds() {
  if (cachedLive && Date.now() - cachedAt < CACHE_MS) return cachedLive;
  if (!refreshInFlight) refreshInFlight = readLiveFeeds().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

function parseCsv(text) {
  const records = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted && ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) { row.push(field); field = ""; }
    else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(value => value !== "")) records.push(row);
      row = [];
    } else field += ch;
  }
  if (field || row.length) { row.push(field); records.push(row); }
  const [header, ...data] = records;
  const keys = header.map(key => key.replace(/^\uFEFF/, ""));
  return data.map(values => Object.fromEntries(keys.map((key, i) => [key, values[i] ?? ""])));
}

function loadFloodAreas() {
  // This small supplied CSV is read synchronously to keep initialization
  // deterministic before the forecast workers start.
  const csv = readFileSync(DISTRICT_CSV, "utf8");
  return parseCsv(csv)
    .map(row => ({
      district: row.district_name_as_in_atlas,
      state: row.state,
      historicFloodAreaHa: Number(row.flood_affected_area_ha) || 0,
      areaBand: row.area_category_ha,
    }))
    .filter(row => row.district && row.state)
    .sort((a, b) => b.historicFloodAreaHa - a.historicFloodAreaHa);
}

function getAtlasDistricts() {
  if (atlasDistricts) return atlasDistricts;
  atlasDistricts = parseCsv(readFileSync(DISTRICT_CSV, "utf8"))
    .map(row => ({
      district: row.district_name_as_in_atlas,
      state: row.state,
      areaHa: Number(row.flood_affected_area_ha) || 0,
      areaKm2: Number(row.flood_affected_area_sq_km) || 0,
      stateShare: Number(row.pct_of_state_total) || 0,
      areaBand: row.area_category_ha,
    }))
    .filter(row => row.district && row.state)
    .sort((a, b) => b.areaHa - a.areaHa)
    .map((row, index) => ({ rank: index + 1, ...row }));
  return atlasDistricts;
}

function searchAtlasDistricts(query, state = "") {
  const normalize = value => String(value || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
  const q = normalize(query);
  const stateFilter = normalize(state);
  if (q.length < 2 && !stateFilter) return { results: [], total: 0, message: "Type at least two letters to search district records." };
  const matches = getAtlasDistricts().filter(item => {
    const matchesQuery = !q || normalize(`${item.district} ${item.state}`).includes(q);
    const matchesState = !stateFilter || normalize(item.state) === stateFilter;
    return matchesQuery && matchesState;
  });
  return { results: matches.slice(0, 12), total: matches.length, truncated: matches.length > 12 };
}

function assessFloodWatch(days, historicFloodAreaHa) {
  const maxDailyMm = Math.max(0, ...days.map(day => Number(day?.day?.totalprecip_mm) || 0));
  const threeDayMm = days.reduce((sum, day) => sum + (Number(day?.day?.totalprecip_mm) || 0), 0);
  const maxRainChance = Math.max(0, ...days.map(day => Number(day?.day?.daily_chance_of_rain) || 0));
  const veryHeavy = maxDailyMm >= 115.6;
  const extremelyHeavy = maxDailyMm >= 204.5;
  const highHistoricalExposure = historicFloodAreaHa >= 50000;
  let level = "lower";
  if (extremelyHeavy || (veryHeavy && highHistoricalExposure && maxRainChance >= 50)) level = "high";
  else if ((maxDailyMm >= 64.5 && highHistoricalExposure && maxRainChance >= 50) ||
           (threeDayMm >= 150 && historicFloodAreaHa >= 100000 && maxRainChance >= 50)) level = "elevated";
  else if ((maxDailyMm >= 20 && historicFloodAreaHa >= 25000 && maxRainChance >= 50) ||
           (maxRainChance >= 70 && threeDayMm > 0 && historicFloodAreaHa >= 50000)) level = "watch";

  const reasons = [];
  if (maxDailyMm >= 64.5) reasons.push(`IMD heavy-rain threshold reached in forecast (${maxDailyMm.toFixed(1)} mm/day)`);
  else if (maxDailyMm >= 20) reasons.push(`Rain forecast: ${maxDailyMm.toFixed(1)} mm on the wettest day`);
  if (maxRainChance) reasons.push(`Rain chance peaks at ${maxRainChance}%`);
  if (highHistoricalExposure) reasons.push(`High historical mapped flood exposure (${Math.round(historicFloodAreaHa).toLocaleString("en-IN")} ha)`);
  if (!reasons.length) reasons.push("No strong rainfall signal in the 3-day forecast");
  return { level, maxDailyMm, threeDayMm, maxRainChance, reasons };
}

async function fetchWeatherForecast(area) {
  const endpoint = new URL("https://api.weatherapi.com/v1/forecast.json");
  endpoint.searchParams.set("key", WEATHER_API_KEY);
  endpoint.searchParams.set("q", `${area.district}, ${area.state}, India`);
  endpoint.searchParams.set("days", "3");
  endpoint.searchParams.set("aqi", "no");
  endpoint.searchParams.set("alerts", "yes");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(endpoint, { signal: controller.signal, headers: { Accept: "application/json" } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = body?.error?.code;
      const message = body?.error?.message || `WeatherAPI returned HTTP ${response.status}`;
      return { ok: false, fatal: response.status === 401 || response.status === 403, error: `WeatherAPI ${code ? `(${code}) ` : ""}${message}`.replaceAll(WEATHER_API_KEY, "[hidden]") };
    }
    const days = body?.forecast?.forecastday || [];
    if (!days.length || !Number.isFinite(Number(body?.location?.lat)) || !Number.isFinite(Number(body?.location?.lon))) {
      return { ok: false, fatal: false, error: "WeatherAPI response did not include forecast days and a mapped location." };
    }
    const assessment = assessFloodWatch(days, area.historicFloodAreaHa);
    if (String(body.location.country || "").toLowerCase() !== "india") {
      return { ok: false, fatal: false, error: "The provider matched this district outside India. Choose a different covered district." };
    }
    const weatherAlerts = (Array.isArray(body?.alerts?.alert) ? body.alerts.alert : []).map(alert => ({
      headline: String(alert?.headline || alert?.event || "Weather alert").slice(0, 240),
      event: String(alert?.event || "Weather alert").slice(0, 120),
      severity: String(alert?.severity || "Unknown").slice(0, 60),
      urgency: String(alert?.urgency || "").slice(0, 60),
      certainty: String(alert?.certainty || "").slice(0, 60),
      areas: String(alert?.areas || "").slice(0, 240),
      effective: String(alert?.effective || "").slice(0, 80),
      expires: String(alert?.expires || "").slice(0, 80),
      description: String(alert?.desc || "").slice(0, 1200),
      instruction: String(alert?.instruction || "").slice(0, 800),
    }));
    return {
      ok: true,
      result: {
        district: area.district,
        state: area.state,
        historicFloodAreaHa: area.historicFloodAreaHa,
        areaBand: area.areaBand,
        locationName: body.location.name,
        providerRegion: body.location.region || "",
        lat: Number(body.location.lat),
        lon: Number(body.location.lon),
        localTime: body.location.localtime,
        current: body.current ? {
          updatedEpoch: Number(body.current.last_updated_epoch) || null,
          temperatureC: body.current.temp_c ?? null,
          precipitationMm: body.current.precip_mm ?? null,
          humidity: body.current.humidity ?? null,
          condition: body.current.condition?.text || "",
        } : null,
        alertFeedAvailable: Array.isArray(body?.alerts?.alert),
        hourly: days.flatMap(day => day.hour || []).map(hour => ({
          epoch: Number(hour.time_epoch), time: hour.time,
          precipitationMm: hour.precip_mm ?? null, chanceOfRain: hour.chance_of_rain ?? null,
        })),
        forecastDays: days.map(item => ({
          date: item.date,
          totalPrecipMm: Number(item?.day?.totalprecip_mm) || 0,
          chanceOfRain: Number(item?.day?.daily_chance_of_rain) || 0,
          condition: item?.day?.condition?.text || "",
        })),
        weatherAlerts,
        ...assessment,
      },
    };
  } catch (error) {
    const message = error?.name === "AbortError" ? "WeatherAPI request timed out." : (error?.message || "WeatherAPI request failed.");
    return { ok: false, fatal: false, error: message.replaceAll(WEATHER_API_KEY, "[hidden]") };
  } finally {
    clearTimeout(timeout);
  }
}

async function restoreWeatherCache() {
  if (weatherCacheLoaded) return;
  weatherCacheLoaded = true;
  try {
    const saved = JSON.parse(await readFile(WEATHER_CACHE_FILE, "utf8"));
    if (saved.sourceVersion === WEATHER_DATA_VERSION && saved.generatedAt && Date.now() - Date.parse(saved.generatedAt) < WEATHER_CACHE_MS) {
      weatherRisk = { ...saved, status: "ready" };
    }
  } catch {}
}

async function buildWeatherRisk() {
  // Publish the in-progress state before any disk or provider work so the
  // browser knows to poll instead of treating the first response as final.
  weatherRisk = { ...weatherRisk, status: "refreshing", results: [], completed: 0, total: 0, failed: 0, generatedAt: null, error: null, cacheSeconds: Math.round(WEATHER_CACHE_MS / 1000), sourceVersion: WEATHER_DATA_VERSION };
  const areas = loadFloodAreas();
  weatherRisk.total = areas.length;
  let cursor = 0;
  let stopped = false;
  const results = [];
  const workers = Array.from({ length: Math.min(WEATHER_CONCURRENCY, areas.length) }, async () => {
    while (!stopped) {
      const index = cursor++;
      if (index >= areas.length) return;
      const fetched = await fetchWeatherForecast(areas[index]);
      weatherRisk.completed++;
      if (fetched.ok) {
        results.push(fetched.result);
        weatherRisk.results = [...results].sort((a, b) => b.maxDailyMm - a.maxDailyMm);
      } else {
        weatherRisk.failed++;
        if (fetched.fatal) {
          stopped = true;
          weatherRisk.error = fetched.error;
        }
      }
      if (weatherRisk.completed % 10 === 0 || weatherRisk.completed === areas.length) {
        weatherRisk.updatedAt = new Date().toISOString();
      }
    }
  });
  await Promise.all(workers);
  weatherRisk.results = results.sort((a, b) => {
    const rank = { high: 0, elevated: 1, watch: 2, lower: 3 };
    return rank[a.level] - rank[b.level] || b.maxDailyMm - a.maxDailyMm || b.historicFloodAreaHa - a.historicFloodAreaHa;
  });
  weatherRisk.generatedAt = new Date().toISOString();
  weatherRisk.sourceVersion = WEATHER_DATA_VERSION;
  weatherRisk.status = weatherRisk.error ? "error" : (results.length ? "ready" : "error");
  if (!results.length && !weatherRisk.error) weatherRisk.error = "No district forecasts could be matched. Check the WeatherAPI key and locations.";
  if (results.length) {
    await import("node:fs/promises").then(({ writeFile }) => writeFile(WEATHER_CACHE_FILE, JSON.stringify(weatherRisk), "utf8")).catch(() => {});

  }
}

async function getWeatherRisk() {
  if (!WEATHER_API_KEY) return { status: "unconfigured", results: [], error: "WeatherAPI key is not configured in the backend environment." };
  await restoreWeatherCache();
  if (weatherRisk.status === "ready" && Date.now() - Date.parse(weatherRisk.generatedAt) < WEATHER_CACHE_MS) return weatherRisk;
  if (weatherRisk.status !== "refreshing" && !weatherRefreshInFlight) {
    weatherRefreshInFlight = buildWeatherRisk().catch(error => {
      weatherRisk = { ...weatherRisk, status: "error", error: error?.message || "Could not build district forecast." };
      console.error("Weather forecast build failed:", weatherRisk.error);
    }).finally(() => { weatherRefreshInFlight = null; });
  }
  return weatherRisk;
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function safeHashEqual(a, b) {
  if (!/^[a-f0-9]{64}$/i.test(a || "") || !/^[a-f0-9]{64}$/i.test(b || "")) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
async function loadSmsStore() {
  if (smsStoreLoaded) return;
  try {
    const parsed = JSON.parse(await readFile(SMS_STORE_FILE, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("Invalid subscriber storage");
    smsStore = parsed;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  smsStoreLoaded = true;
}
async function saveSmsStore() {
  const temp = `${SMS_STORE_FILE}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(smsStore), { encoding: "utf8", mode: 0o600 });
  await rename(temp, SMS_STORE_FILE);
}
async function smsProviderSend(to, body) {
  if (!SMS_CONFIGURED) throw new Error("SMS delivery is not configured on this server.");
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const form = new URLSearchParams({ To: to, From: TWILIO_FROM_NUMBER, Body: body });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Messages.json`, {
    method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" }, body: form,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const providerError = await response.json().catch(() => ({}));
    throw new Error(`SMS provider rejected the message (HTTP ${response.status}, code ${providerError.code || "unknown"}).`);
  }
}
function smsUnsubscribeUrl(subscriber, token) {
  subscriber.unsubscribeToken ||= token;
  subscriber.unsubscribeHash = hash(subscriber.unsubscribeToken);
  return `${PUBLIC_BASE_URL}/api/sms/unsubscribe?token=${encodeURIComponent(subscriber.unsubscribeToken)}`;
}
function smsOptOutLine(unsubscribeUrl = "") {
  return `Unsubscribe: ${unsubscribeUrl}`;
}
async function readJsonBody(req, limit = 4096) {
  const body = await readRequestBody(req, limit);
  try { return JSON.parse(body || "{}"); }
  catch { throw new Error("Send a valid JSON request."); }
}
async function readRequestBody(req, limit = 4096) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > limit) throw new Error("Request body is too large.");
  }
  return body;
}
async function subscribeSms(req, res) {
  if (!allowRequest(req, res)) return;
  if (!SMS_CONFIGURED) return json(res, 503, { error: "SMS alerts are not configured yet. The site owner must add Twilio credentials to the backend environment." });
  let input;
  try { input = await readJsonBody(req); } catch (error) { return json(res, 400, { error: error.message }); }
  const phone = String(input.phone || "").trim();
  const district = String(input.district || "").trim().slice(0, 100);
  const state = String(input.state || "").trim().slice(0, 100);
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) return json(res, 400, { error: "Enter a phone number in international format, for example +919876543210." });
  if (!getAtlasDistricts().some(a => a.district === district && a.state === state)) return json(res, 400, { error: "Choose a covered district from the search results." });
  if (input.consent !== true) return json(res, 400, { error: "Please confirm that you agree to receive flood-watch SMS alerts and can opt out at any time." });
  await loadSmsStore();
  let subscriber = smsStore.find(item => item.phone === phone);
  const now = Date.now();
  while (smsOtpSentAt.length && now - smsOtpSentAt[0] >= 3600_000) smsOtpSentAt.shift();
  if (smsOtpSentAt.length >= SMS_OTP_MAX_PER_HOUR) return json(res, 429, { error: "SMS verification limit reached for this server. Try again later." });
  if (subscriber?.lastOtpSentAt && now - subscriber.lastOtpSentAt < 60_000) return json(res, 429, { error: "Please wait a minute before requesting another verification code." });
  if (subscriber?.otpWindowAt && now - subscriber.otpWindowAt < 24 * 3600_000 && subscriber.otpCount >= 3) return json(res, 429, { error: "Verification SMS limit reached for today. Try again tomorrow." });
  const code = String(randomInt(100000, 1000000));
  subscriber ||= { phone };
  // A code request cannot change an existing verified subscription.
  subscriber.pending = { district, state, consentAt: new Date().toISOString() };
  subscriber.otpHash = hash(code);
  subscriber.otpExpiresAt = now + 10 * 60_000;
  subscriber.otpAttempts = 0;
  subscriber.lastOtpSentAt = now;
  if (!subscriber.otpWindowAt || now - subscriber.otpWindowAt >= 24 * 3600_000) { subscriber.otpWindowAt = now; subscriber.otpCount = 0; }
  subscriber.otpCount = (subscriber.otpCount || 0) + 1;
  if (!smsStore.includes(subscriber)) smsStore.push(subscriber);
  smsOtpSentAt.push(now);
  try {
    await smsProviderSend(phone, `FloodWatch: your verification code is ${code}. It expires in 10 minutes. Do not share this code.`);
    await saveSmsStore();
    return json(res, 200, { ok: true, message: "Verification code sent. Enter it here to confirm your subscription." });
  } catch (error) {
    subscriber.otpHash = "";
    await saveSmsStore().catch(() => {});
    console.error("SMS verification send failed:", error.message);
    return json(res, 502, { error: "Could not send the verification SMS. Check the provider configuration and phone number." });
  }
}
async function verifySms(req, res) {
  if (!allowRequest(req, res)) return;
  let input;
  try { input = await readJsonBody(req); } catch (error) { return json(res, 400, { error: error.message }); }
  const phone = String(input.phone || "").trim();
  const code = String(input.code || "").trim();
  if (!/^\+[1-9]\d{7,14}$/.test(phone) || !/^\d{6}$/.test(code)) return json(res, 400, { error: "Enter the phone number and six-digit verification code." });
  await loadSmsStore();
  const subscriber = smsStore.find(item => item.phone === phone);
  if (!subscriber?.otpHash || Date.now() > subscriber.otpExpiresAt) return json(res, 400, { error: "That code has expired. Request a new verification code." });
  subscriber.otpAttempts = (subscriber.otpAttempts || 0) + 1;
  if (subscriber.otpAttempts > 5) { subscriber.otpHash = ""; await saveSmsStore(); return json(res, 429, { error: "Too many incorrect codes. Request a new code." }); }
  if (!safeHashEqual(subscriber.otpHash, hash(code))) { await saveSmsStore(); return json(res, 400, { error: "That verification code is incorrect." }); }
  if (!subscriber.pending) return json(res, 400, { error: "Request a new verification code." });
  Object.assign(subscriber, subscriber.pending);
  delete subscriber.pending;
  subscriber.otpHash = "";
  subscriber.otpExpiresAt = 0;
  subscriber.verified = true;
  subscriber.verifiedAt = new Date().toISOString();
  subscriber.unsubscribedAt = null;
  const token = randomBytes(32).toString("hex");
  const unsubscribeUrl = smsUnsubscribeUrl(subscriber, token);
  await saveSmsStore();
  // Successful number verification activates the subscription. Confirmation is shown in the browser.
  return json(res, 200, { ok: true, message: `SMS alerts enabled for ${subscriber.district}, ${subscriber.state}.`, unsubscribeUrl });
}

// SMS work is serialized so writes, verification and opt-outs cannot race.
let smsQueue = Promise.resolve();
function smsTask(task, res) {
  const result = smsQueue.then(task);
  smsQueue = result.catch(() => {});
  return result.catch(() => { if (res && !res.headersSent) json(res, 503, { error: "SMS service is temporarily unavailable. Please retry." }); });
}
let smsChecking = false;
async function monitorSmsSubscribers() {
  if (!SMS_CONFIGURED || smsChecking) return;
  smsChecking = true;
  try {
    const areas = await smsTask(async () => {
      await loadSmsStore();
      return [...new Map(smsStore.filter(s => s.verified && !s.unsubscribedAt)
        .map(s => [s.state + "|" + s.district, {district:s.district,state:s.state}])).values()];
    });
    for (const chosen of areas || []) {
      const area = loadFloodAreas().find(a => a.district === chosen.district && a.state === chosen.state);
      if (!area) continue;
      const fetched = await fetchWeatherForecast(area);
      if (!fetched.ok) continue;
      await smsTask(() => sendRiskSmsAlerts([fetched.result]));
    }
  } finally { smsChecking = false; }
}
async function sendRiskSmsAlerts(results) {
  if (!SMS_CONFIGURED) return;
  await loadSmsStore();
  const now = Date.now();
  const today = new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(now));
  for (const subscriber of smsStore) {
    if (!subscriber.verified || subscriber.unsubscribedAt) continue;
    const area = results.find(a => a.district === subscriber.district && a.state === subscriber.state);
    const observed = area?.current?.updatedEpoch * 1000;
    if (!area || !["high", "elevated"].includes(area.level) || !Number.isFinite(observed) || observed > now + 60000 || now - observed > 90 * 60000) continue;
    if (!area.forecastDays?.some(d => d.date === today) || !Number.isFinite(area.maxDailyMm) || !Number.isFinite(area.maxRainChance)) continue;
    const alertKey = `${area.state}|${area.district}|${today}|${area.level}`;
    subscriber.alertHistory = (subscriber.alertHistory || []).filter(h => now - h.at < 7 * 86400000);
    if (subscriber.alertHistory.some(h => h.key === alertKey)) continue;
    if (now - (subscriber.lastAttemptAt || 0) < 3600000 && !(area.level === "high" && subscriber.lastLevel === "elevated")) continue;
    const unsubscribeUrl = smsUnsubscribeUrl(subscriber, randomBytes(32).toString("hex"));
    const text = `FloodWatch: ${area.level === "high" ? "High" : "Elevated"} flood watch for ${area.district}, ${area.state}. Forecast up to ${Math.round(area.maxDailyMm)} mm/day; ${Math.round(area.maxRainChance)}% rain chance. Screening only. Follow local official guidance. ${smsOptOutLine(unsubscribeUrl)}`;
    // Reserve the event durably before sending: an ambiguous timeout must not send duplicate texts.
    const entry = { key: alertKey, at: now, status: "pending" };
    subscriber.alertHistory.push(entry);
    subscriber.lastAttemptAt = now;
    subscriber.lastLevel = area.level;
    await saveSmsStore();
    try {
      await smsProviderSend(subscriber.phone, text);
      entry.status = "accepted"; // Provider acceptance does not confirm handset delivery.
    } catch { entry.status = "unconfirmed"; }
    await saveSmsStore();
  }
}
async function unsubscribeSms(res, token) {
  if (!token || token.length > 128) return send(res, 400, "Invalid unsubscribe link.", { "Content-Type": "text/plain; charset=utf-8" });
  await loadSmsStore();
  const subscriber = smsStore.find(item => item.unsubscribeHash && safeHashEqual(item.unsubscribeHash, hash(token)));
  if (!subscriber) return send(res, 404, "This unsubscribe link is invalid or already used.", { "Content-Type": "text/plain; charset=utf-8" });
  subscriber.unsubscribedAt = new Date().toISOString();
  subscriber.verified = false;
  subscriber.unsubscribeHash = "";
  delete subscriber.unsubscribeToken;
  delete subscriber.pending;
  subscriber.otpHash = "";
  await saveSmsStore();
  return send(res, 200, "SMS alerts have been turned off for this number.", { "Content-Type": "text/plain; charset=utf-8" });
}
async function unsubscribePage(res, token) {
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) return send(res, 400, "Invalid unsubscribe link.", { "Content-Type": "text/plain; charset=utf-8" });
  await loadSmsStore();
  if (!smsStore.some(item => item.unsubscribeHash && safeHashEqual(item.unsubscribeHash, hash(token)))) return send(res, 404, "This unsubscribe link is invalid or already used.", { "Content-Type": "text/plain; charset=utf-8" });
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Turn off FloodWatch SMS</title><main style="font:16px system-ui;max-width:460px;margin:12vh auto;padding:28px;color:#20272b;border:1px solid #d9ded8;border-radius:12px"><h1 style="font-size:24px">Turn off SMS alerts?</h1><p>Confirm to stop FloodWatch SMS alerts for this number.</p><form method="post" action="/api/sms/unsubscribe"><input type="hidden" name="token" value="${token}"><button style="padding:11px 16px;border:0;border-radius:7px;background:#203d49;color:white;font:inherit">Confirm unsubscribe</button></form></main>`;
  return send(res, 200, html, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
}
async function inboundSms(req, res) {
  if (!TWILIO_AUTH_TOKEN || !PUBLIC_BASE_URL) return send(res, 503, "SMS callback is not configured.", { "Content-Type": "text/plain; charset=utf-8" });
  let raw;
  try { raw = Object.fromEntries(new URLSearchParams(await readRequestBody(req, 4096))); }
  catch (error) { return json(res, 400, { error: error.message }); }
  const signature = String(req.headers["x-twilio-signature"] || "");
  const callbackUrl = `${PUBLIC_BASE_URL}/api/sms/inbound`;
  const signed = callbackUrl + Object.keys(raw).sort().map(key => key + String(raw[key])).join("");
  const hmac = createHmac("sha1", TWILIO_AUTH_TOKEN).update(signed).digest("base64");
  if (!signature || Buffer.byteLength(signature) !== Buffer.byteLength(hmac) || !timingSafeEqual(Buffer.from(signature), Buffer.from(hmac))) return send(res, 403, "Invalid provider signature.", { "Content-Type": "text/plain; charset=utf-8" });
  await loadSmsStore();
  const phone = String(raw.From || "").trim();
  const body = String(raw.Body || "").trim().toUpperCase();
  if (/^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT)$/.test(body)) {
    const subscriber = smsStore.find(item => item.phone === phone);
    if (subscriber) { subscriber.unsubscribedAt = new Date().toISOString(); subscriber.verified = false; subscriber.unsubscribeHash = ""; delete subscriber.unsubscribeToken; delete subscriber.pending; subscriber.otpHash = ""; await saveSmsStore(); }
  }
  return send(res, 200, "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>", { "Content-Type": "text/xml; charset=utf-8" });
}

async function serveStatic(req, res, url) {
  let pathname;
  try { pathname = url.pathname === "/" ? `/${HOME_PAGE}` : decodeURIComponent(url.pathname); }
  catch { return send(res, 400, "Invalid path."); }
  const target = path.resolve(PUBLIC, `.${pathname}`);
  if (target !== PUBLIC && !target.startsWith(PUBLIC + path.sep)) {
    return send(res, 403, "Forbidden", { "Content-Type": "text/plain; charset=utf-8" });
  }
  try {
    const body = await readFile(target);
    const type = contentTypes[path.extname(target).toLowerCase()] || "application/octet-stream";
    send(res, 200, body, { "Content-Type": type, "Cache-Control": "no-cache" });
  } catch {
    send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "POST" && url.pathname === "/api/sms/inbound") return smsTask(() => inboundSms(req, res), res);
  if (req.method === "GET" && url.pathname === "/api/sms/status") return json(res, 200, { configured: SMS_CONFIGURED, checkMinutes: 5 });
  if (req.method === "GET" && url.pathname === "/api/sms/unsubscribe") return smsTask(() => unsubscribePage(res, url.searchParams.get("token")), res);
  if (req.method === "POST" && url.pathname === "/api/sms/unsubscribe") {
    let body;
    try { body = Object.fromEntries(new URLSearchParams(await readRequestBody(req, 4096))); }
    catch (error) { return json(res, 400, { error: error.message }); }
    return smsTask(() => unsubscribeSms(res, body.token), res);
  }
  if (req.method === "POST" && url.pathname === "/api/sms/subscribe") return smsTask(() => subscribeSms(req, res), res);
  if (req.method === "POST" && url.pathname === "/api/sms/verify") return smsTask(() => verifySms(req, res), res);
  if (req.method !== "GET" && req.method !== "HEAD") {
    return json(res, 405, { error: "Only GET and HEAD are supported." });
  }
  if (url.pathname === "/api/health") return json(res, 200, { ok: true, service: "floodwatch-imd-backend" });
  if (url.pathname === "/api/reservoirs") {
    if (!allowRequest(req, res)) return;
    const result=await getReservoirs();
    return json(res, result.error && !result.reservoirs.length ? 502 : 200, result);
  }
  if (url.pathname === "/api/atlas/districts") {
    if (!allowRequest(req, res)) return;
    try {
      const result = searchAtlasDistricts(url.searchParams.get("q") || "", url.searchParams.get("state") || "");
      return json(res, 200, result);
    } catch (error) {
      console.error("Atlas district search failed:", error.message);
      return json(res, 500, { error: "District records are temporarily unavailable." });
    }
  }
  if (url.pathname === "/api/monitor") {
    if (!allowRequest(req, res)) return;
    if (!WEATHER_API_KEY) return json(res, 503, { error: "Weather monitoring is not configured." });
    const district = url.searchParams.get("district");
    const state = url.searchParams.get("state");
    const area = loadFloodAreas().find(item => item.district === district && item.state === state);
    if (!area) return json(res, 400, { error: "Choose a district from the available forecast areas." });
    const key = `${state}|${district}`;
    const saved = monitors.get(key);
    if (saved && Date.now() - Date.parse(saved.fetchedAt) < 300000) return json(res, 200, saved);
    if (!monitorFlights.has(key)) {
      if (monitorFlights.size >= 5) return json(res, 429, { error: "Monitoring is busy. Please retry shortly." });
      monitorFlights.set(key, fetchWeatherForecast(area).then(fetched => {
        if (!fetched.ok) return { error: fetched.error };
        const result = { result: fetched.result, fetchedAt: new Date().toISOString(), refreshSeconds: 300 };
        if (monitors.size >= 100) monitors.delete(monitors.keys().next().value);
        monitors.set(key, result);
        return result;
      }).finally(() => monitorFlights.delete(key)));
    }
    const result = await monitorFlights.get(key);
    return json(res, result.error ? 502 : 200, result);
  }
  if (url.pathname === "/api/risk") {
    if (!allowRequest(req, res)) return;
    const result = await getWeatherRisk();
    return json(res, result.status === "error" ? 502 : 200, result);
  }
  if (url.pathname === "/api/live") {
    if (!allowRequest(req, res)) return;
    const result = await liveFeeds();
    return json(res, result.warnings.ok || result.rainfall.ok ? 200 : 502, result);
  }
  return serveStatic(req, res, url);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`FloodWatch is listening on http://localhost:${PORT}`);
  console.log(`IMD feed cache: ${Math.round(CACHE_MS / 1000)} seconds`);
  console.log(`WeatherAPI key configured: ${WEATHER_API_KEY ? "yes" : "no"}`);
  console.log(`Weather forecast cache: ${Math.round(WEATHER_CACHE_MS / 3600_000)} hours · district count loaded on first request`);
});
// Keep the nationwide scan running while this server is up; the six-hour
// provider cache prevents a five-minute scan from making 439 fresh API calls.
setInterval(() => getWeatherRisk().catch(() => {}), 300000).unref();

setTimeout(() => monitorSmsSubscribers().catch(() => {}), 15000).unref();
setInterval(() => monitorSmsSubscribers().catch(() => {}), 300000).unref();
