const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const path = require("path");
const fs = require("fs");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// -------------------------------------
// Utility: Formatted Logging Function
// -------------------------------------
function logActivity(activity, details = "") {
  const now = new Date().toLocaleString("en-US", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  console.log(`[${now}] ${activity}${details ? " | " + details : ""}`);
}

// -------------------------------------
// Security: Rate Limiting (Prevent API Abuse)
// -------------------------------------
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: { error: "Too many requests, please try again later." },
});
app.use(limiter);

// -------------------------------------
// CORS Middleware (Whitelisted Domains)
// -------------------------------------
const allowedOrigins = ["https://yourfrontend.com", "http://localhost:5173"];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// -------------------------------------
// Static File Middleware for Images
// -------------------------------------
const imagesDir = path.join(__dirname, "images");
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir);
app.use("/images", express.static(imagesDir));

// -------------------------------------
// JSON Body Parser Middleware
// -------------------------------------
app.use(express.json());

// -------------------------------------
// MongoDB Connection & Indexes
// -------------------------------------
let client;
const uri = process.env.MONGO_URI || "mongodb+srv://wednesday:wednesday@cluster0.2q635.mongodb.net/after_school_activities?retryWrites=true&w=majority";

async function initializeDatabase() {
  try {
    client = new MongoClient(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      maxPoolSize: 10, // Use connection pooling
    });
    await client.connect();
    logActivity("Info", "Connected to MongoDB");

    const db = client.db("after_school_activities");
    await db.collection("lessons").createIndex({ subject: "text", location: "text" });

    logActivity("Info", "Indexes created");
  } catch (err) {
    logActivity("Error", `Database error: ${err.message}`);
    process.exit(1);
  }
}
initializeDatabase();

// Graceful shutdown
process.on("SIGINT", async () => {
  logActivity("Info", "Closing database connection...");
  if (client) await client.close();
  process.exit(0);
});

// Helper: Get Database
const getDb = () => {
  if (!client) throw new Error("Database client not initialized");
  return client.db("after_school_activities");
};

// -------------------------------------
// API Routes
// -------------------------------------

// Root Route
app.get("/", (req, res) => {
  res.send("School Activities API is running");
});

// GET /lessons (with Pagination)
app.get("/lessons", async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const lessons = await getDb().collection("lessons")
      .find()
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .toArray();
    res.json(lessons);
  } catch (err) {
    logActivity("Error", `Fetch lessons failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// PUT /lessons/:id (Update Lesson)
app.put("/lessons/:id", async (req, res) => {
  try {
    const updates = req.body;
    delete updates._id;
    const result = await getDb().collection("lessons").findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updates },
      { returnDocument: "after" }
    );
    if (!result.value) return res.status(404).json({ error: "Lesson not found" });
    res.json(result.value);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /search?q=term (Full-text Search)
app.get("/search", async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: "Query parameter is required" });

    const results = await getDb().collection("lessons")
      .find({ $text: { $search: query } })
      .toArray();

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /orders (Create Order)
app.post("/orders", async (req, res) => {
  try {
    const { name, phone, lessons } = req.body;
    if (!name || !phone || !Array.isArray(lessons)) {
      return res.status(400).json({ error: "Invalid input" });
    }

    const order = {
      name: name.trim(),
      phone,
      lessons,
      date: new Date(),
      status: "confirmed",
    };

    const result = await getDb().collection("orders").insertOne(order);
    res.status(201).json({ message: "Order created successfully", orderId: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /orders (Fetch Orders with Pagination)
app.get("/orders", async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const orders = await getDb().collection("orders")
      .find()
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .toArray();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 404 Not Found Handler
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// General Error Handler
app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message });
});

// -------------------------------------
// Start Server
// -------------------------------------
app.listen(PORT, () => {
  logActivity("Info", `Server running on port ${PORT}`);
});
