const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ic = n => `<svg class="ic"><use href="#i-${n}"/></svg>`;
const hue = s => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const av = (n, t) => (t === "group" || t === "general")
  ? `<span class="av sq" style="--h:${hue(n)}">${ic("users")}</span>`
  : `<span class="av" style="--h:${hue(n)}">${esc((n[0] || "?").toUpperCase())}</span>`;
const clock = t => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtT = t => { const d = new Date(t); return d.toDateString() === new Date().toDateString() ? clock(t) : d.toLocaleDateString([], { day: "numeric", month: "short" }); };
const lk = s => esc(s).replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
const api = async (u, m = "GET", b) => {
  const r = await fetch(u, { method: m, headers: b ? { "Content-Type": "application/json" } : {}, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); let d; try { d = JSON.parse(t) } catch { d = t }
  if (!r.ok) throw new Error(typeof d === "string" ? d : "Error");
  return d;
};
function toast(t) { const e = $("#toast"); e.textContent = t; e.classList.add("show"); clearTimeout(e._t); e._t = setTimeout(() => e.classList.remove("show"), 2800); }

let me, socket, active = null, tab = "all", pending = null, mode, picked = new Set(), allUsers = [], typingT, lastTyped = 0, online = new Set();
const rooms = new Map(), msgs = {}, unread = {};
const rname = r => r.type === "dm" ? (r.members.find(m => m !== me) || "?") : r.name;
const upsert = r => rooms.set(r._id, { ...rooms.get(r._id), ...r });

// ---------- theme ----------
const setTheme = t => { document.documentElement.dataset.theme = t; localStorage.theme = t; };
setTheme(localStorage.theme || (matchMedia("(prefers-color-scheme:dark)").matches ? "dark" : "light"));
$("#themeBtn").onclick = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");

// ---------- auth ----------
let signup = false;
$("#authSwitch").onclick = e => {
  e.preventDefault(); signup = !signup;
  $("#authTitle").textContent = signup ? "Create account" : "Welcome back";
  $("#authSub").textContent = signup ? "Free te Alapon-e join koro" : "Continue korte login koro";
  $("#authBtn").textContent = signup ? "Sign up" : "Login";
  $("#authAsk").textContent = signup ? "Account ache?" : "Account nai?";
  $("#authSwitch").textContent = signup ? "Login" : "Sign up";
};
$("#authForm").onsubmit = async e => {
  e.preventDefault(); const f = new FormData(e.target);
  try { me = (await api(signup ? "/signup" : "/login", "POST", { username: f.get("username"), password: f.get("password") })).username; start(); }
  catch (x) { toast(x.message); }
};
$("#logout").onclick = async () => { await api("/logout", "POST", {}); location.reload(); };
(async () => { try { me = (await api("/api/me")).username; start(); } catch { } })();

// ---------- start ----------
async function start() {
  $("#auth").hidden = true; $("#app").hidden = false;
  $("#meName").textContent = me; $("#meAv").innerHTML = av(me);
  (await api("/api/rooms")).forEach(r => rooms.set(r._id, r));
  socket = io();
  socket.on("online", l => { online = new Set(l); renderRooms(); if (active) head(); if (infoOpen()) info(); });
  socket.on("message", onMsg);
  socket.on("typing", ({ room, user }) => {
    if (room !== active || user === me) return;
    $("#typing").textContent = `${user} is typing…`; clearTimeout(typingT);
    typingT = setTimeout(() => $("#typing").textContent = "", 2500);
  });
  socket.on("room:new", r => { upsert(r); renderRooms(); });
  socket.on("room:update", r => { upsert(r); renderRooms(); if (r._id === active) { head(); if (infoOpen()) info(); } });
  socket.on("room:removed", id => { rooms.delete(id); if (active === id) leaveChat(); renderRooms(); });
  renderRooms();
}

// ---------- chat list ----------
function renderRooms() {
  const q = $("#search").value.toLowerCase();
  const list = [...rooms.values()]
    .filter(r => (tab === "all" || (tab === "group" ? r.type !== "dm" : r.type === "dm")) && rname(r).toLowerCase().includes(q))
    .sort((a, b) => new Date(b.last?.time || b.createdAt) - new Date(a.last?.time || a.createdAt));
  $("#roomList").innerHTML = list.map(r => {
    const n = rname(r), l = r.last, u = unread[r._id] || 0;
    const pre = l ? (l.user === me ? "You: " : r.type === "dm" ? "" : l.user + ": ") + (l.text || "📎 " + (l.fileName || "File")) : "No messages yet";
    return `<div class="ri${r._id === active ? " on" : ""}" data-id="${r._id}"><div class="avw">${av(n, r.type)}${r.type === "dm" && online.has(n) ? '<i class="dot"></i>' : ""}</div>
      <div class="rm"><div class="r1"><b>${esc(n)}</b><small>${l ? fmtT(l.time) : ""}</small></div><div class="r2"><span>${esc(pre)}</span>${u ? `<em>${u}</em>` : ""}</div></div></div>`;
  }).join("") || `<p class="none">No chats found</p>`;
}
$("#roomList").onclick = e => { const i = e.target.closest(".ri"); if (i) openRoom(i.dataset.id); };
$("#search").oninput = renderRooms;
$$(".tabs button").forEach(b => b.onclick = () => { tab = b.dataset.t; $$(".tabs button").forEach(x => x.classList.toggle("on", x === b)); renderRooms(); });

// ---------- open / close chat ----------
async function openRoom(id) {
  active = id; unread[id] = 0;
  $("#empty").hidden = true; $("#conv").hidden = false; $("#app").classList.add("in-chat");
  $("#info").classList.remove("open"); $("#typing").textContent = "";
  head(); renderRooms();
  if (!msgs[id]) msgs[id] = await api(`/api/rooms/${id}/messages`);
  if (active === id) { drawMsgs(); if (innerWidth > 760) $("#msg").focus(); }
}
function leaveChat() { active = null; $("#conv").hidden = true; $("#empty").hidden = false; $("#app").classList.remove("in-chat"); $("#info").classList.remove("open"); }
$("#back").onclick = () => { active = null; $("#app").classList.remove("in-chat"); renderRooms(); };
function head() {
  const r = rooms.get(active); if (!r) return; const n = rname(r);
  $("#cAv").innerHTML = av(n, r.type); $("#cName").textContent = n;
  $("#cSub").textContent = r.type === "dm" ? (online.has(n) ? "Online" : "Offline")
    : r.type === "general" ? `${online.size} online` : `${r.members.length} members · ${r.members.filter(m => online.has(m)).length} online`;
}

// ---------- messages ----------
function fileHtml(m) {
  const u = `/uploads/${encodeURIComponent(m.file)}`, e = m.file.split(".").pop().toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(e)) return `<a href="${u}" target="_blank"><img class="mf" src="${u}" loading="lazy"></a>`;
  if (["mp4", "webm", "mov"].includes(e)) return `<video class="mf" controls preload="metadata" src="${u}"></video>`;
  return `<a class="fc" href="${u}" target="_blank" download>${ic("clip")}<span>${esc(m.fileName || m.file)}</span></a>`;
}
function bubble(m, prev, r) {
  const mine = m.user === me, day = new Date(m.time).toDateString(); let h = "";
  const newDay = !prev || new Date(prev.time).toDateString() !== day;
  if (newDay) h += `<div class="day"><span>${new Date(m.time).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}</span></div>`;
  const first = newDay || prev.user !== m.user || new Date(m.time) - new Date(prev.time) > 3e5;
  return h + `<div class="row${mine ? " me" : ""}${first ? " first" : ""}">${mine ? "" : `<div class="aw">${first ? av(m.user) : ""}</div>`}<div class="b">
    ${first && !mine && r.type !== "dm" ? `<div class="who" style="color:hsl(${hue(m.user)} 60% 52%)">${esc(m.user)}</div>` : ""}
    ${m.text ? `<div class="t">${lk(m.text)}</div>` : ""}${m.file ? fileHtml(m) : ""}<time>${clock(m.time)}</time></div></div>`;
}
function drawMsgs() {
  const r = rooms.get(active), list = msgs[active] || []; let h = "", prev = null;
  list.forEach(m => { h += bubble(m, prev, r); prev = m; });
  $("#msgs").innerHTML = h || `<p class="none">Say hello 👋</p>`;
  $("#msgs").scrollTop = 1e9;
}
function onMsg(m) {
  const r = rooms.get(m.room); if (!r) return;
  r.last = m; if (msgs[m.room]) msgs[m.room].push(m);
  if (m.room === active && msgs[active]) {
    const el = $("#msgs"), l = msgs[active], near = el.scrollHeight - el.scrollTop - el.clientHeight < 160 || m.user === me;
    if (l.length < 2) drawMsgs(); else el.insertAdjacentHTML("beforeend", bubble(m, l[l.length - 2], r));
    if (near) el.scrollTop = 1e9;
    $("#typing").textContent = "";
  } else if (m.user !== me) unread[m.room] = (unread[m.room] || 0) + 1;
  renderRooms();
}

// ---------- composer ----------
const autoH = () => { const t = $("#msg"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 140) + "px"; };
function send() {
  const text = $("#msg").value.trim();
  if (!active || (!text && !pending)) return;
  socket.emit("message", { room: active, text, file: pending?.file, fileName: pending?.fileName });
  $("#msg").value = ""; autoH(); clearChip();
}
$("#send").onclick = send;
$("#msg").onkeydown = e => { if (e.key === "Enter" && !e.shiftKey && innerWidth > 760) { e.preventDefault(); send(); } };
$("#msg").oninput = () => { autoH(); if (Date.now() - lastTyped > 2000) { lastTyped = Date.now(); socket.emit("typing", active); } };
$("#attach").onclick = () => $("#file").click();
$("#file").onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  chip(`Uploading ${f.name}…`); const fd = new FormData(); fd.append("file", f);
  try { const r = await fetch("/upload", { method: "POST", body: fd }); if (!r.ok) throw new Error(await r.text()); pending = await r.json(); chip(f.name, true); }
  catch (x) { toast(x.message); clearChip(); }
  e.target.value = "";
};
function chip(t, ok) { const c = $("#chip"); c.hidden = false; c.innerHTML = `${ic("clip")}<span>${esc(t)}</span>${ok ? `<button class="ib" id="chipX">${ic("x")}</button>` : ""}`; if (ok) $("#chipX").onclick = clearChip; }
function clearChip() { pending = null; $("#chip").hidden = true; }

// ---------- info panel ----------
const infoOpen = () => $("#info").classList.contains("open");
$("#infoBtn").onclick = () => { info(); $("#info").classList.toggle("open"); };
$("#infoClose").onclick = () => $("#info").classList.remove("open");
function info() {
  const r = rooms.get(active); if (!r) return; const n = rname(r), isAdmin = (r.admins || []).includes(me);
  const mem = r.type === "general" ? [...online] : r.members;
  $("#infoBody").innerHTML = `<div class="ip">${av(n, r.type)}<h3>${esc(n)}</h3><small>${r.type === "dm" ? "Direct chat" : r.type === "general" ? "Open to everyone" : `Group · ${r.members.length} members`}</small></div>
    <h4>${r.type === "general" ? "Online now" : "Members"}</h4>
    ${mem.map(u => `<div class="ui">${av(u)}<span>${esc(u)}${u === me ? " (you)" : ""}${online.has(u) ? '<i class="dot s"></i>' : ""}</span>${(r.admins || []).includes(u) ? '<em class="tag">Admin</em>' : ""}</div>`).join("")}
    ${r.type === "group" ? `${isAdmin ? `<button class="btn ghost" id="addM">${ic("plus")} Add members</button>` : ""}<button class="btn danger" id="leaveG">Leave group</button>` : ""}`;
  if ($("#addM")) $("#addM").onclick = () => pick("add");
  if ($("#leaveG")) $("#leaveG").onclick = async () => { if (confirm("Ei group chere dibe?")) try { await api(`/api/groups/${active}/leave`, "POST", {}); } catch (x) { toast(x.message); } };
}

// ---------- picker modal (group / dm / add) ----------
async function pick(m) {
  mode = m; picked = new Set();
  $("#mTitle").textContent = { group: "New group", dm: "New chat", add: "Add members" }[m];
  $("#gName").hidden = m !== "group"; $("#gName").value = ""; $("#uSearch").value = "";
  $("#mOk").hidden = m === "dm"; $("#mOk").textContent = m === "group" ? "Create group" : "Add to group";
  $("#modal").hidden = false; $("#uList").innerHTML = `<p class="none">Loading…</p>`;
  try { allUsers = await api("/api/users"); } catch (x) { toast(x.message); }
  drawUsers();
}
function drawUsers() {
  const q = $("#uSearch").value.toLowerCase(), skip = mode === "add" ? rooms.get(active).members : [];
  const l = allUsers.filter(u => !skip.includes(u) && u.toLowerCase().includes(q));
  $("#uList").innerHTML = l.map(u => `<div class="ui${picked.has(u) ? " on" : ""}" data-u="${esc(u)}">${av(u)}<span>${esc(u)}${online.has(u) ? '<i class="dot s"></i>' : ""}</span>${mode === "dm" ? "" : `<b class="ck">${picked.has(u) ? "✓" : ""}</b>`}</div>`).join("") || `<p class="none">Keu nai</p>`;
  $("#mOk").disabled = mode !== "dm" && !picked.size;
}
$("#uSearch").oninput = drawUsers;
$("#uList").onclick = async e => {
  const i = e.target.closest(".ui"); if (!i) return; const u = i.dataset.u;
  if (mode === "dm") { try { const r = await api("/api/dm", "POST", { user: u }); upsert(r); $("#modal").hidden = true; openRoom(r._id); } catch (x) { toast(x.message); } return; }
  picked.has(u) ? picked.delete(u) : picked.add(u); drawUsers();
};
$("#mOk").onclick = async () => {
  try {
    if (mode === "group") {
      const name = $("#gName").value.trim(); if (!name) return toast("Group-er ekta naam daw");
      const r = await api("/api/groups", "POST", { name, members: [...picked] }); upsert(r); $("#modal").hidden = true; openRoom(r._id);
    } else {
      upsert(await api(`/api/groups/${active}/members`, "POST", { users: [...picked] })); $("#modal").hidden = true; head(); info(); renderRooms();
    }
  } catch (x) { toast(x.message); }
};
$("#grpBtn").onclick = $("#grpBtn2").onclick = () => pick("group");
$("#dmBtn").onclick = () => pick("dm");
$("#mClose").onclick = () => $("#modal").hidden = true;
$("#modal").onclick = e => { if (e.target.id === "modal") $("#modal").hidden = true; };
