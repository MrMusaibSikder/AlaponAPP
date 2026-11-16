require("dotenv").config();
const express = require("express"), path = require("path"), fs = require("fs");
const app = express(), http = require("http").createServer(app), io = require("socket.io")(http);
const session = require("express-session"), bcrypt = require("bcrypt"), multer = require("multer"), mongoose = require("mongoose");

if (!process.env.MONGO_URI) { console.error("❌ .env file e MONGO_URI nai"); process.exit(1); }
fs.mkdirSync("uploads", { recursive: true });

// ---------- middleware (session socket.io-teo share hoy) ----------
const sessionMw = session({
  secret: process.env.SESSION_SECRET || "dev-secret-change-me",
  resave: false, saveUninitialized: false, cookie: { maxAge: 7 * 864e5 }
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMw);
io.engine.use(sessionMw);
const auth = (req, res, next) => req.session.username ? next() : res.status(401).send("Please login");
app.use(express.static("public"));
app.use("/uploads", auth, express.static("uploads"));

// ---------- database ----------
const User = mongoose.model("User", new mongoose.Schema({ username: { type: String, unique: true }, password: String }));
const Room = mongoose.model("Room", new mongoose.Schema({
  name: String,
  type: { type: String, enum: ["general", "group", "dm"] },
  members: [String], admins: [String],
  createdAt: { type: Date, default: Date.now }
}));
const Message = mongoose.model("Message", new mongoose.Schema({
  room: { type: mongoose.Schema.Types.ObjectId, index: true },
  user: String, text: String, file: String, fileName: String,
  time: { type: Date, default: Date.now }
}));
mongoose.connect(process.env.MONGO_URI).then(async () => {
  console.log("✅ MongoDB connected");
  if (!(await Room.exists({ type: "general" }))) await Room.create({ name: "Everyone", type: "general" });
}).catch(e => console.error("❌ MongoDB error", e.message));

// ---------- helpers ----------
const bad = (res, m) => res.status(400).send(m);
const can = (r, u) => r.type === "general" || r.members.includes(u);
const getRoom = async (id, u) => { try { const r = await Room.findById(id); return r && can(r, u) ? r : null; } catch { return null; } };
const pushTo = (ev, data, users) => users.forEach(u => io.to("user:" + u).emit(ev, data));
const joinAll = (r, users) => users.forEach(u => io.in("user:" + u).socketsJoin("room:" + r._id));
const existing = async list => (await User.find({ username: { $in: [].concat(list || []).map(String) } }).select("username")).map(u => u.username);

// ---------- auth ----------
app.post("/signup", async (req, res) => {
  const username = String(req.body.username || "").trim(), password = String(req.body.password || "");
  if (!username || /\s/.test(username) || username.length > 20) return bad(res, "Username: 1-20 characters, no spaces");
  if (password.length < 6) return bad(res, "Password must be at least 6 characters");
  if (await User.exists({ username })) return bad(res, "Username already exists");
  await User.create({ username, password: await bcrypt.hash(password, 10) });
  req.session.username = username;
  res.json({ username });
});
app.post("/login", async (req, res) => {
  const u = await User.findOne({ username: String(req.body.username || "").trim() });
  if (!u || !(await bcrypt.compare(String(req.body.password || ""), u.password))) return bad(res, "Wrong username or password");
  req.session.username = u.username;
  res.json({ username: u.username });
});
app.post("/logout", (req, res) => req.session.destroy(() => res.send("OK")));
app.get("/api/me", auth, (req, res) => res.json({ username: req.session.username }));
app.get("/api/users", auth, async (req, res) =>
  res.json((await User.find({ username: { $ne: req.session.username } }).select("username").sort("username")).map(u => u.username)));

// ---------- rooms ----------
app.get("/api/rooms", auth, async (req, res) => {
  const rooms = await Room.find({ $or: [{ type: "general" }, { members: req.session.username }] });
  res.json(await Promise.all(rooms.map(async r => ({ ...r.toJSON(), last: await Message.findOne({ room: r._id }).sort("-time").lean() }))));
});
app.get("/api/rooms/:id/messages", auth, async (req, res) => {
  const r = await getRoom(req.params.id, req.session.username);
  if (!r) return bad(res, "No access");
  res.json((await Message.find({ room: r._id }).sort("-time").limit(150).lean()).reverse());
});

// group create
app.post("/api/groups", auth, async (req, res) => {
  const me = req.session.username, name = String(req.body.name || "").trim().slice(0, 40);
  if (!name) return bad(res, "Group name required");
  const members = [...new Set([me, ...(await existing(req.body.members))])];
  const r = await Room.create({ name, type: "group", members, admins: [me] });
  joinAll(r, members); pushTo("room:new", r, members);
  res.json(r);
});
// direct chat
app.post("/api/dm", auth, async (req, res) => {
  const me = req.session.username, other = String(req.body.user || "");
  if (other === me || !(await User.exists({ username: other }))) return bad(res, "User not found");
  let r = await Room.findOne({ type: "dm", members: { $all: [me, other] } });
  if (!r) { r = await Room.create({ type: "dm", members: [me, other] }); joinAll(r, [me, other]); pushTo("room:new", r, [me, other]); }
  res.json(r);
});
// add members (admin only)
app.post("/api/groups/:id/members", auth, async (req, res) => {
  const me = req.session.username, r = await getRoom(req.params.id, me);
  if (!r || r.type !== "group" || !r.admins.includes(me)) return bad(res, "Only admins can add members");
  const added = (await existing(req.body.users)).filter(u => !r.members.includes(u));
  r.members.push(...added); await r.save();
  joinAll(r, added); pushTo("room:new", r, added);
  pushTo("room:update", r, r.members.filter(u => !added.includes(u)));
  res.json(r);
});
// leave group
app.post("/api/groups/:id/leave", auth, async (req, res) => {
  const me = req.session.username, r = await getRoom(req.params.id, me);
  if (!r || r.type !== "group") return bad(res, "Not a group");
  r.members = r.members.filter(u => u !== me);
  r.admins = r.admins.filter(u => u !== me);
  io.in("user:" + me).socketsLeave("room:" + r._id);
  pushTo("room:removed", String(r._id), [me]);
  if (!r.members.length) { await Message.deleteMany({ room: r._id }); await r.deleteOne(); }
  else { if (!r.admins.length) r.admins = [r.members[0]]; await r.save(); pushTo("room:update", r, r.members); }
  res.send("OK");
});

// ---------- upload ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: "uploads/",
    filename: (q, f, cb) => cb(null, Date.now() + "_" + f.originalname.replace(/[^\w.\-]/g, "_"))
  }),
  limits: { fileSize: 25 * 1024 * 1024 }
});
app.post("/upload", auth, upload.single("file"), (req, res) => {
  if (!req.file) return bad(res, "No file");
  res.json({ file: req.file.filename, fileName: req.file.filename.replace(/^\d+_/, "") });
});
app.use((err, req, res, next) => res.status(400).send(err.code === "LIMIT_FILE_SIZE" ? "File too large (max 25MB)" : "Something went wrong"));

// ---------- realtime ----------
const online = new Map();
io.on("connection", async socket => {
  const me = socket.request.session && socket.request.session.username;
  if (!me) return socket.disconnect(true);
  socket.join("user:" + me);
  (await Room.find({ $or: [{ type: "general" }, { members: me }] })).forEach(r => socket.join("room:" + r._id));
  online.set(me, (online.get(me) || 0) + 1);
  io.emit("online", [...online.keys()]);

  socket.on("message", async d => {
    try {
      if (!d || !socket.rooms.has("room:" + d.room)) return;
      const text = String(d.text || "").trim().slice(0, 4000);
      const file = d.file ? path.basename(String(d.file)) : undefined;
      if (!text && !file) return;
      const msg = await Message.create({ room: d.room, user: me, text, file, fileName: file ? String(d.fileName || file).slice(0, 120) : undefined });
      io.to("room:" + d.room).emit("message", msg);
    } catch (e) { console.error(e.message); }
  });
  socket.on("typing", id => { if (socket.rooms.has("room:" + id)) socket.to("room:" + id).emit("typing", { room: id, user: me }); });
  socket.on("disconnect", () => {
    const n = (online.get(me) || 1) - 1;
    n ? online.set(me, n) : online.delete(me);
    io.emit("online", [...online.keys()]);
  });
});

http.listen(process.env.PORT || 3000, () => console.log("🚀 http://localhost:" + (process.env.PORT || 3000)));
