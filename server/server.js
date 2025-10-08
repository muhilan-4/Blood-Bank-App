// server/server.js
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const app = express();
app.use(cors());
app.use(express.json());

// ---------- serve static frontend ----------
const CLIENT_DIR = path.join(__dirname, "..", "client");
app.use(express.static(CLIENT_DIR));
app.get("/", (_req, res) => res.redirect("/login"));
app.get("/login", (_req, res) => res.sendFile(path.join(CLIENT_DIR, "Login.html")));
app.get("/register", (_req, res) => res.sendFile(path.join(CLIENT_DIR, "Register.html")));
app.get("/welcome", (_req, res) => res.sendFile(path.join(CLIENT_DIR, "Welcomepage.html")));
app.get("/profile", (_req, res) => res.sendFile(path.join(CLIENT_DIR, "Profile.html")));

// --------------- persistence ----------------
const USERS_FILE = path.join(__dirname, "users.json");
const SEED_FILE  = path.join(__dirname, "seed-users.json");

let users = [];
let nextId = 1;

function loadUsers() {
  if (fs.existsSync(USERS_FILE)) {
    try {
      users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
      nextId = users.reduce((m,u)=>Math.max(m,(+u.id||0)),0)+1;
    } catch { users = []; nextId = 1; }
  }
}
function saveUsers() {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
  catch (e) { console.warn("saveUsers failed:", e.message); }
}
loadUsers();

// -------------- geocode cache --------------
const CACHE_FILE = path.join(__dirname, "geo-cache.json");
let cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) : {};
const saveCache = () => {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); }
  catch (e) { console.warn("cache save failed:", e.message); }
};

// ----------------- helpers -----------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function normalizeAddress(raw) {
  return String(raw || "")
    .replace(/\s+/g, " ")
    .replace(/,\s*,/g, ", ")
    .replace(/\bNgr\b/ig, "Nagar")
    .replace(/\bRd\b/ig, "Road")
    .replace(/\bCol\b/ig, "Colony")
    .trim();
}
function extractPin(addr) {
  const m = String(addr).match(/\b(\d{6})\b/);
  return m ? m[1] : null;
}
async function nominatim(params) {
  const url = "https://nominatim.openstreetmap.org/search";
  const headers = { "User-Agent": "BloodLinkDemo/1.0 (contact@example.com)" };
  const res = await axios.get(url, { params, headers, timeout: 15000 });
  await sleep(1100); // be polite (~1 req/sec)
  return Array.isArray(res.data) ? res.data : [];
}
async function geocode(address) {
  if (!address) return null;
  const clean = normalizeAddress(address);
  const pin   = extractPin(clean);
  const k1    = `addr:${clean.toLowerCase()}`;
  if (cache[k1]) return cache[k1];

  // 1) Full address (India bias)
  let list = await nominatim({
    q: clean, format: "jsonv2", limit: 3, addressdetails: 1,
    countrycodes: "in", "accept-language": "en"
  });
  if (list[0]) {
    const p = { lat: +list[0].lat, lon: +list[0].lon, addressNormalized: clean };
    cache[k1] = p; saveCache(); return p;
  }

  // 2) PIN lookup
  if (pin) {
    const k2 = `pin:${pin}`;
    if (cache[k2]) return cache[k2];
    list = await nominatim({
      postalcode: pin, countrycodes: "in", format: "jsonv2", limit: 1, addressdetails: 1
    });
    if (list[0]) {
      const p = { lat: +list[0].lat, lon: +list[0].lon, addressNormalized: clean };
      cache[k2] = p; saveCache(); return p;
    }
  }

  // 3) City guess + PIN (Tamil Nadu example)
  const cityGuess =
    (clean.match(/([A-Za-z\s]+)\s+\d{6}\s*,\s*Tamil Nadu/i) || [])[1] ||
    (clean.match(/,\s*([A-Za-z\s]+)\s*,\s*Tamil Nadu/i) || [])[1] || "";
  if (cityGuess) {
    list = await nominatim({
      q: `${cityGuess.trim()} ${pin || ""}, Tamil Nadu, India`,
      format: "jsonv2", limit: 3, addressdetails: 1,
      countrycodes: "in", "accept-language": "en"
    });
    if (list[0]) {
      const p = { lat: +list[0].lat, lon: +list[0].lon, addressNormalized: clean };
      cache[k1] = p; saveCache(); return p;
    }
  }

  // 4) Final fallback: "PIN, India"
  if (pin) {
    list = await nominatim({ q: `${pin}, India`, format: "jsonv2", limit: 1, countrycodes: "in" });
    if (list[0]) {
      const p = { lat: +list[0].lat, lon: +list[0].lon, addressNormalized: clean };
      cache[`pin:${pin}`] = p; saveCache(); return p;
    }
  }
  return null;
}
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const COMPAT = {
  "A+": ["A+","A-","O+","O-"], "A-": ["A-","O-"],
  "B+": ["B+","B-","O+","O-"], "B-": ["B-","O-"],
  "AB+": ["A+","A-","B+","B-","AB+","AB-","O+","O-"],
  "AB-": ["AB-","A-","B-","O-"],
  "O+": ["O+","O-"], "O-": ["O-"]
};

// ----------------- API -----------------
app.get("/api/health", (_req, res) => res.json({ ok: true, users: users.length }));

// Register
app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password, bloodGroup, phone, address } = req.body || {};
    if (!name || !email || !password || !bloodGroup || !address)
      return res.status(400).json({ error: "name, email, password, bloodGroup, address are required" });

    if (users.find(u => u.email.toLowerCase() === String(email).toLowerCase()))
      return res.status(409).json({ error: "Email already exists" });

    const geo = await geocode(address);
    if (!geo) return res.status(422).json({ error: "Could not geocode address; please refine it" });

    const user = {
      id: String(nextId++),
      name, email, passwordHash: password,
      bloodGroup, phone: phone || "",
      addressRaw: address, addressNormalized: geo.addressNormalized,
      lat: geo.lat, lon: geo.lon,
      lastDonatedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    users.push(user);
    saveUsers();
    res.json({ ok: true, user: { ...user, passwordHash: undefined } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error", detail: String(e.message) });
  }
});

// Login
app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  const u = users.find(x => x.email.toLowerCase() === String(email).toLowerCase() && x.passwordHash === password);
  if (!u) return res.status(401).json({ error: "Invalid credentials" });
  res.json({ ok: true, userId: u.id });
});

// Get profile
app.get("/api/users/:id", (req, res) => {
  const u = users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: "User not found" });
  const safe = { ...u }; delete safe.passwordHash;
  res.json({ ok: true, user: safe });
});

// Update profile (re-geocode if address changed)
app.put("/api/users/:id", async (req, res) => {
  try {
    const u = users.find(x => x.id === req.params.id);
    if (!u) return res.status(404).json({ error: "User not found" });

    const { name, phone, bloodGroup, address } = req.body || {};
    if (name !== undefined) u.name = name;
    if (phone !== undefined) u.phone = phone;
    if (bloodGroup !== undefined) u.bloodGroup = bloodGroup;

    if (address !== undefined && address.trim() && address.trim() !== u.addressRaw) {
      const geo = await geocode(address);
      if (!geo) return res.status(422).json({ error: "Could not geocode new address" });
      u.addressRaw = address;
      u.addressNormalized = geo.addressNormalized;
      u.lat = geo.lat; u.lon = geo.lon;
    }

    u.updatedAt = new Date().toISOString();
    saveUsers();
    const safe = { ...u }; delete safe.passwordHash;
    res.json({ ok: true, user: safe });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error", detail: String(e.message) });
  }
});

// Nearest donor for a given userId
app.get("/api/nearest", (req, res) => {
  const { userId } = req.query;
  const me = users.find(x => x.id === String(userId));
  if (!me) return res.status(404).json({ error: "Requesting user not found" });

  const acceptable = COMPAT[me.bloodGroup] || [];
  const candidates = users.filter(u =>
    u.id !== me.id && acceptable.includes(u.bloodGroup) && u.lat != null && u.lon != null
  );
  if (!candidates.length) return res.json({ ok: true, nearest: null, message: "No compatible donors yet" });

  const ranked = candidates
    .map(d => ({ donor: d, km: haversineKm(me.lat, me.lon, d.lat, d.lon) }))
    .sort((a, b) => a.km - b.km);

  const top = ranked[0];
  res.json({
    ok: true,
    me: { id: me.id, name: me.name, bloodGroup: me.bloodGroup, lat: me.lat, lon: me.lon },
    nearest: {
      id: top.donor.id, name: top.donor.name, bloodGroup: top.donor.bloodGroup,
      address: top.donor.addressNormalized, km: Number(top.km.toFixed(2))
    },
    top5: ranked.slice(0,5).map(x => ({
      id: x.donor.id, name: x.donor.name, bloodGroup: x.donor.bloodGroup,
      km: Number(x.km.toFixed(2))
    }))
  });
});

// ---------- seed once if empty ----------
async function importSeedIfEmpty() {
  if (users.length > 0) return;
  if (!fs.existsSync(SEED_FILE)) return;
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));

  for (const s of seed) {
    if (users.find(u => u.email.toLowerCase() === s.email.toLowerCase())) continue;
    const geo = await geocode(s.address);
    if (!geo) continue;
    const user = {
      id: String(nextId++),
      name: s.name, email: s.email, passwordHash: s.password,
      bloodGroup: s.bloodGroup, phone: s.phone || "",
      addressRaw: s.address, addressNormalized: geo.addressNormalized,
      lat: geo.lat, lon: geo.lon,
      lastDonatedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    users.push(user);
    saveUsers();
  }
}

// ---------- auto-open (no external deps) ----------
function autoOpen(url) {
  try {
    if (process.platform === "win32") exec(`start "" "${url}"`);
    else if (process.platform === "darwin") exec(`open "${url}"`);
    else exec(`xdg-open "${url}"`);
  } catch (e) {
    console.log("Auto-open skipped:", e.message);
  }
}

// ---------- start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await importSeedIfEmpty();
  const url = `http://localhost:${PORT}/login`;
  console.log(`API + static server running at ${url}`);
  autoOpen(url);
});
