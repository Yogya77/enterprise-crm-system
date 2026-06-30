const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_FILE = path.join(__dirname, "data", "db.json");
const sessions = new Map();
const mimeTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8" };

function readDb() { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
function writeDb(db) { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
function sendJson(res, status, data) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data)); }
function safeUser(user) { return { id: user.id, name: user.name, email: user.email, role: user.role }; }
function currentUser(req) { return sessions.get((req.headers.authorization || "").replace("Bearer ", "")) || null; }
function newId(prefix) { return prefix + "-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8); }
function today() { return new Date().toISOString().slice(0, 10); }
function addActivity(db, type, note) { db.activities.unshift({ id: newId("activity"), type, note, date: today() }); }

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 1000000) reject(new Error("Request is too large")); });
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); } });
  });
}

function dashboard(db) {
  const wonDeals = db.deals.filter(deal => deal.stage === "Won");
  const openDeals = db.deals.filter(deal => !["Won", "Lost"].includes(deal.stage));
  const stageTotals = {};
  const leadSources = {};
  db.deals.forEach(deal => { stageTotals[deal.stage] = (stageTotals[deal.stage] || 0) + 1; });
  db.leads.forEach(lead => { leadSources[lead.source] = (leadSources[lead.source] || 0) + 1; });
  return {
    totalLeads: db.leads.length,
    totalCustomers: db.customers.length,
    openDeals: openDeals.length,
    totalRevenue: wonDeals.reduce((sum, deal) => sum + Number(deal.value || 0), 0),
    openPipeline: openDeals.reduce((sum, deal) => sum + Number(deal.value || 0), 0),
    stageTotals,
    leadSources
  };
}

async function handleApi(req, res) {
  const db = readDb();
  const route = new URL(req.url, "http://localhost").pathname;

  if (route === "/api/login" && req.method === "POST") {
    const body = await parseBody(req);
    const user = db.users.find(item => item.email === body.email && item.password === body.password);
    if (!user) return sendJson(res, 401, { message: "Invalid email or password." });
    const token = crypto.randomBytes(24).toString("hex");
    sessions.set(token, safeUser(user));
    return sendJson(res, 200, { token, user: safeUser(user) });
  }

  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { message: "Please login first." });

  if (route === "/api/dashboard" && req.method === "GET") return sendJson(res, 200, { stats: dashboard(db), activities: db.activities.slice(0, 8) });
  if (route === "/api/leads" && req.method === "GET") return sendJson(res, 200, { leads: db.leads });
  if (route === "/api/customers" && req.method === "GET") return sendJson(res, 200, { customers: db.customers });
  if (route === "/api/deals" && req.method === "GET") return sendJson(res, 200, { deals: db.deals });
  if (route === "/api/activities" && req.method === "GET") return sendJson(res, 200, { activities: db.activities });

  if (route === "/api/leads" && req.method === "POST") {
    const body = await parseBody(req);
    const lead = { id: newId("lead"), name: body.name, company: body.company, email: body.email, phone: body.phone, source: body.source, status: body.status, owner: user.name, createdAt: today() };
    db.leads.unshift(lead);
    addActivity(db, "Lead", user.name + " added lead " + lead.name);
    writeDb(db);
    return sendJson(res, 201, { lead });
  }

  if (route.startsWith("/api/leads/") && req.method === "PUT") {
    const leadId = route.split("/").pop();
    const body = await parseBody(req);
    const index = db.leads.findIndex(lead => lead.id === leadId);
    if (index === -1) return sendJson(res, 404, { message: "Lead not found." });
    db.leads[index] = { ...db.leads[index], ...body };
    addActivity(db, "Lead", user.name + " updated lead " + db.leads[index].name);
    writeDb(db);
    return sendJson(res, 200, { lead: db.leads[index] });
  }

  if (route.startsWith("/api/leads/") && req.method === "DELETE") {
    if (user.role !== "Admin") return sendJson(res, 403, { message: "Only Admin can delete leads." });
    const leadId = route.split("/").pop();
    const deleted = db.leads.find(lead => lead.id === leadId);
    db.leads = db.leads.filter(lead => lead.id !== leadId);
    if (deleted) addActivity(db, "Lead", user.name + " deleted lead " + deleted.name);
    writeDb(db);
    return sendJson(res, 200, { success: true });
  }

  if (route === "/api/customers" && req.method === "POST") {
    const body = await parseBody(req);
    const customer = { id: newId("customer"), name: body.name, company: body.company, email: body.email, plan: body.plan, health: body.health, value: Number(body.value || 0) };
    db.customers.unshift(customer);
    addActivity(db, "Customer", user.name + " added customer " + customer.company);
    writeDb(db);
    return sendJson(res, 201, { customer });
  }

  if (route === "/api/deals" && req.method === "POST") {
    const body = await parseBody(req);
    const deal = { id: newId("deal"), title: body.title, company: body.company, value: Number(body.value || 0), stage: body.stage, owner: user.name, closeDate: body.closeDate };
    db.deals.unshift(deal);
    addActivity(db, "Deal", user.name + " created deal " + deal.title);
    writeDb(db);
    return sendJson(res, 201, { deal });
  }

  if (route.startsWith("/api/deals/") && req.method === "PUT") {
    const dealId = route.split("/").pop();
    const body = await parseBody(req);
    const index = db.deals.findIndex(deal => deal.id === dealId);
    if (index === -1) return sendJson(res, 404, { message: "Deal not found." });
    db.deals[index] = { ...db.deals[index], ...body };
    addActivity(db, "Deal", user.name + " moved " + db.deals[index].title + " to " + db.deals[index].stage);
    writeDb(db);
    return sendJson(res, 200, { deal: db.deals[index] });
  }

  sendJson(res, 404, { message: "Route not found." });
}

function serveStatic(req, res) {
  const requested = req.url === "/" ? "index.html" : req.url.slice(1);
  const filePath = path.join(PUBLIC_DIR, requested);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(filePath, (error, content) => {
    if (error) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "text/plain" });
    res.end(content);
  });
}

http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) await handleApi(req, res);
    else serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { message: error.message });
  }
}).listen(PORT, () => console.log("Enterprise CRM System running at http://localhost:" + PORT));
