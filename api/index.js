export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Izinkan akses dari browser
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // 1. Endpoint Manual Check untuk Web Dashboard
  if (url.pathname === "/api/status") {
    const results = await checkAllTargets();
    return res.status(200).json({
      timestamp: new Date().toISOString(),
      targets: results
    });
  }

  // 2. Endpoint Trigger 5 Menit (Dipanggil oleh cron-job.org)
  if (url.pathname === "/api/cron-5m") {
    if (req.query.key !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    await runFiveMinuteChecks();
    return res.status(200).json({ ok: true, task: "5m-check" });
  }

  // 3. Endpoint Trigger Digest Pagi & Sore (Dipanggil oleh cron-job.org)
  if (url.pathname === "/api/cron-digest") {
    if (req.query.key !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    await runScheduledDigest();
    return res.status(200).json({ ok: true, task: "digest" });
  }

  // 4. Endpoint Webhook Remote Command Telegram
  if (url.pathname === "/api/telegram" && req.method === "POST") {
    const update = req.body;
    if (update && update.message && update.message.text) {
      const chatId = String(update.message.chat.id);
      if (chatId === String(process.env.TELEGRAM_CHAT_ID)) {
        await handleTelegramCommand(update.message.text.trim());
      }
    }
    return res.status(200).send("OK");
  }

  return res.status(200).send("Sentinel Ops Vercel Engine Active");
}

// ==========================================
// MONITORING & ALERT DARURAT
// ==========================================
async function checkAllTargets() {
  const targets = [
    { name: "GitHub API", url: "https://api.github.com", critical: true },
    { name: "Cloudflare Status", url: "https://www.cloudflarestatus.com/api/v2/status.json", critical: true },
    { name: "Render App Utama", url: process.env.RENDER_APP_URL || "https://example.com", critical: true }
  ];

  const results = [];
  for (const target of targets) {
    const start = Date.now();
    try {
      const response = await fetch(target.url, {
        headers: { "User-Agent": "SentinelMonitor/1.0" },
        signal: AbortSignal.timeout(7000)
      });
      results.push({
        name: target.name,
        url: target.url,
        up: response.ok,
        status: response.status,
        latency: Date.now() - start,
        critical: target.critical
      });
    } catch (err) {
      results.push({
        name: target.name,
        url: target.url,
        up: false,
        status: "TIMEOUT/ERR",
        latency: Date.now() - start,
        critical: target.critical
      });
    }
  }
  return results;
}

async function runFiveMinuteChecks() {
  const results = await checkAllTargets();
  const downTargets = results.filter(t => !t.up);

  for (const down of downTargets) {
    if (process.env.RESTART_WEBHOOK_URL && down.name.includes("Render")) {
      await fetch(process.env.RESTART_WEBHOOK_URL, { method: "POST" }).catch(() => {});
    }

    const alertMsg = `🚨 ALERT DOWN: ${down.name}\nStatus: ${down.status}\nURL: ${down.url}`;
    await sendTelegram(alertMsg, true);

    if (down.critical && process.env.CALLMEBOT_API_KEY && process.env.PHONE_NUMBER) {
      const callText = encodeURIComponent(`Peringatan darurat. Layanan ${down.name} mengalami gangguan.`);
      const callUrl = `https://api.callmebot.com/start.php?user=${process.env.PHONE_NUMBER}&text=${callText}&lang=id-ID-Standard-A&rpt=2&cc=yes&apikey=${process.env.CALLMEBOT_API_KEY}`;
      await fetch(callUrl).catch(() => {});
    }
  }

  await checkBreakingNews();
}

// ==========================================
// RADAR BREAKING NEWS & DIGEST
// ==========================================
const RSS_SOURCES = [
  { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" }
];

function extractTitlesFromXML(xmlText) {
  const titles = [];
  const regex = /<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/gi;
  let match;
  while ((match = regex.exec(xmlText)) !== null) {
    const clean = match[1].trim();
    if (clean && !clean.includes("BBC News") && !clean.includes("Al Jazeera") && !clean.includes("CoinDesk")) {
      titles.push(clean);
    }
  }
  return titles.slice(0, 5);
}

async function checkBreakingNews() {
  const urgentKeywords = ["war", "missile", "earthquake", "tsunami", "attack", "nuclear", "hack", "crash", "emergency", "invasion"];
  let matchedSources = 0;
  let sampleHeadline = "";

  for (const src of RSS_SOURCES.slice(0, 2)) {
    try {
      const res = await fetch(src.url);
      const xml = await res.text();
      const titles = extractTitlesFromXML(xml);
      const hit = titles.find(t => urgentKeywords.some(kw => t.toLowerCase().includes(kw)));
      if (hit) {
        matchedSources++;
        sampleHeadline = `${src.name}: ${hit}`;
      }
    } catch (e) {}
  }

  if (matchedSources >= 2) {
    const msg = `⚠️ BREAKING NEWS ALERT ⚠️\nTerdeteksi isu darurat di ${matchedSources} sumber berita:\n\n${sampleHeadline}`;
    await sendTelegram(msg, true);
  }
}

async function runScheduledDigest() {
  let digestLines = ["📰 DAILY BRIEFING"];

  for (const src of RSS_SOURCES) {
    try {
      const res = await fetch(src.url);
      const xml = await res.text();
      const titles = extractTitlesFromXML(xml).slice(0, 2);
      digestLines.push(`\n[${src.name}]`);
      titles.forEach(t => digestLines.push(`- ${t}`));
    } catch (e) {}
  }

  try {
    const marketRes = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,solana&vs_currencies=usd,idr");
    const market = await marketRes.json();
    digestLines.push(`\n📊 MARKET SNAPSHOT`);
    digestLines.push(`BTC: $${market.bitcoin.usd} (Rp ${market.bitcoin.idr.toLocaleString("id-ID")})`);
    digestLines.push(`SOL: $${market.solana.usd} (Rp ${market.solana.idr.toLocaleString("id-ID")})`);
  } catch (e) {}

  await sendTelegram(digestLines.join("\n"), false);
}

// ==========================================
// REMOTE COMMAND & TELEGRAM HELPER
// ==========================================
async function handleTelegramCommand(text) {
  if (text === "/status") {
    const results = await checkAllTargets();
    const report = results.map(r => `${r.up ? "✅" : "❌"} ${r.name} (${r.latency}ms)`).join("\n");
    await sendTelegram(`📡 STATUS SAAT INI:\n\n${report}`, false);
  } else if (text === "/news") {
    await runScheduledDigest();
  } else if (text === "/restart") {
    if (process.env.RESTART_WEBHOOK_URL) {
      await fetch(process.env.RESTART_WEBHOOK_URL, { method: "POST" }).catch(() => {});
      await sendTelegram("🔄 Perintah restart sudah ditembak ke server.", false);
    } else {
      await sendTelegram("⚠️ URL webhook restart belum diset.", false);
    }
  }
}

async function sendTelegram(text, isUrgent) {
  const token = (isUrgent && process.env.URGENT_BOT_TOKEN) ? process.env.URGENT_BOT_TOKEN : process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      disable_web_page_preview: true
    })
  }).catch(() => {});
}
