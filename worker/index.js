export default {
  // 1. Handler saat diakses lewat Web Dashboard atau Webhook Telegram
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Header CORS agar bisa diakses bebas dari Cloudflare Pages dashboard
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Endpoint Manual Check untuk Web Dashboard
    if (url.pathname === "/api/status") {
      const results = await checkAllTargets(env);
      return new Response(JSON.stringify({
        timestamp: new Date().toISOString(),
        targets: results
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Endpoint Webhook Remote Command dari Telegram
    if (url.pathname === "/webhook/telegram" && request.method === "POST") {
      try {
        const update = await request.json();
        if (update.message && update.message.text) {
          const chatId = String(update.message.chat.id);
          const text = update.message.text.trim();

          // Pastikan hanya membalas chat dari ID milikmu sendiri
          if (chatId === String(env.TELEGRAM_CHAT_ID)) {
            await handleTelegramCommand(text, env);
          }
        }
      } catch (e) {
        // Abaikan payload tidak valid
      }
      return new Response("OK", { status: 200 });
    }

    return new Response("Sentinel Ops Engine Active", { status: 200 });
  },

  // 2. Handler Otomatis dari Cron Triggers Cloudflare
  async scheduled(event, env, ctx) {
    if (event.cron === "*/5 * * * *") {
      ctx.waitUntil(runFiveMinuteChecks(env));
    } else if (event.cron === "0 0,10 * * *") {
      ctx.waitUntil(runScheduledDigest(env));
    }
  }
};

// ==========================================
// FUNGSI MONITORING & ALERT DARURAT
// ==========================================
async function checkAllTargets(env) {
  // Daftar target pantauan (bisa ditambah lewat Env Variable TARGETS_JSON)
  const defaultTargets = [
    { name: "GitHub API", url: "https://api.github.com", critical: true },
    { name: "Cloudflare Status", url: "https://www.cloudflarestatus.com/api/v2/status.json", critical: true },
    { name: "Render App Utama", url: env.RENDER_APP_URL || "https://example.com", critical: true }
  ];

  let targets = defaultTargets;
  if (env.TARGETS_JSON) {
    try { targets = JSON.parse(env.TARGETS_JSON); } catch (e) {}
  }

  const results = [];
  for (const target of targets) {
    const start = Date.now();
    try {
      const res = await fetch(target.url, {
        headers: { "User-Agent": "SentinelMonitor/1.0" },
        signal: AbortSignal.timeout(8000)
      });
      const latency = Date.now() - start;
      results.push({
        name: target.name,
        url: target.url,
        up: res.ok,
        status: res.status,
        latency: latency,
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

async function runFiveMinuteChecks(env) {
  // A. Cek Uptime Server & Layanan
  const results = await checkAllTargets(env);
  const downTargets = results.filter(t => !t.up);

  for (const down of downTargets) {
    // Jika punya webhook auto-restart, tembak maksimal 1x per siklus sebelum lapor
    if (env.RESTART_WEBHOOK_URL && down.name.includes("Render")) {
      await fetch(env.RESTART_WEBHOOK_URL, { method: "POST" }).catch(() => {});
    }

    const alertMsg = `🚨 ALERT DOWN: ${down.name}\nStatus: ${down.status}\nURL: ${down.url}`;
    await sendTelegram(env, alertMsg, true);

    // Pemicu panggilan darurat (CallMeBot) jika layanan bersifat kritis
    if (down.critical && env.CALLMEBOT_API_KEY && env.PHONE_NUMBER) {
      const callText = encodeURIComponent(`Peringatan darurat. Layanan ${down.name} mengalami gangguan atau mati.`);
      const callUrl = `https://api.callmebot.com/start.php?user=${env.PHONE_NUMBER}&text=${callText}&lang=id-ID-Standard-A&rpt=2&cc=yes&apikey=${env.CALLMEBOT_API_KEY}`;
      await fetch(callUrl).catch(() => {});
    }
  }

  // B. Radar Breaking News (Cek Kata Kunci Bencana/Perang Multi-Sumber)
  await checkBreakingNews(env);
}

// ==========================================
// FUNGSI RADAR BREAKING NEWS & DIGEST
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

async function checkBreakingNews(env) {
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

  // Kirim peringatan jika kata kunci darurat muncul di minimal 2 sumber berbeda
  if (matchedSources >= 2) {
    const msg = `⚠️ BREAKING NEWS ALERT ⚠️\nTerdeteksi isu darurat di ${matchedSources} sumber berita:\n\n${sampleHeadline}`;
    await sendTelegram(env, msg, true);
  }
}

async function runScheduledDigest(env) {
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

  // Ambil harga pasar ringkas dari CoinGecko (Gratis tanpa API Key)
  try {
    const marketRes = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,solana&vs_currencies=usd,idr");
    const market = await marketRes.json();
    digestLines.push(`\n📊 MARKET SNAPSHOT`);
    digestLines.push(`BTC: $${market.bitcoin.usd} (Rp ${market.bitcoin.idr.toLocaleString("id-ID")})`);
    digestLines.push(`SOL: $${market.solana.usd} (Rp ${market.solana.idr.toLocaleString("id-ID")})`);
  } catch (e) {}

  await sendTelegram(env, digestLines.join("\n"), false);
}

// ==========================================
// REMOTE COMMAND & TELEGRAM HELPER
// ==========================================
async function handleTelegramCommand(text, env) {
  if (text === "/status") {
    const results = await checkAllTargets(env);
    const report = results.map(r => `${r.up ? "✅" : "❌"} ${r.name} (${r.latency}ms)`).join("\n");
    await sendTelegram(env, `📡 STATUS SAAT INI:\n\n${report}`, false);
  } else if (text === "/news") {
    await runScheduledDigest(env);
  } else if (text === "/restart") {
    if (env.RESTART_WEBHOOK_URL) {
      await fetch(env.RESTART_WEBHOOK_URL, { method: "POST" }).catch(() => {});
      await sendTelegram(env, "🔄 Perintah restart sudah ditembak ke server.", false);
    } else {
      await sendTelegram(env, "⚠️ URL webhook restart belum diset di Environment Variables.", false);
    }
  }
}

async function sendTelegram(env, text, isUrgent) {
  // Gunakan bot khusus darurat jika tersedia dan statusnya urgent
  const token = (isUrgent && env.URGENT_BOT_TOKEN) ? env.URGENT_BOT_TOKEN : env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      disable_web_page_preview: true
    })
  }).catch(() => {});
}
