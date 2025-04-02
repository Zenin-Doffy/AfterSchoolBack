const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// -------------------------------------
// Utility: Formatted Logging Function
// -------------------------------------
function logActivity(activity, details = "") {
  const now = new Date();
  const formattedTime = now.toLocaleString("en-US", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  console.log(`[${formattedTime}] ${activity}${details ? " | " + details : ""}`);
}

// -------------------------------------
// CORS Middleware
// -------------------------------------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// -------------------------------------
// Logger Middleware
// -------------------------------------
app.use((req, res, next) => {
  logActivity("Request", `${req.method} ${req.url}`);
  next();
});

// -------------------------------------
// Static File Middleware for Images
// -------------------------------------
const imagesDir = path.join(__dirname, "images");
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir);
}
app.use("/images", express.static(imagesDir, {
  fallthrough: false,
  setHeaders: (res, filePath) => {
    res.set("Cache-Control", "public, max-age=3600");
  }
}));

// -------------------------------------
// JSON Body Parser Middleware
// -------------------------------------
app.use(express.json());

// -------------------------------------
// MongoDB Connection and Helpers
// -------------------------------------
let client;
const uri = process.env.MONGO_URI || "mongodb+srv://wednesday:wednesday@cluster0.2q635.mongodb.net/after_school_activities?retryWrites=true&w=majority";

// Helper: get current DB instance
function getDb() {
  if (!client) throw new Error("Database client not initialized");
  return client.db("after_school_activities");
}

// Helper: retry mechanism with exponential backoff
async function executeWithRetry(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i < retries - 1) {
        await new Promise((res) => setTimeout(res, delay));
        delay *= 2;
      } else {
        throw error;
      }
    }
  }
}

// Initialize MongoDB connection and indexes
async function initializeDatabase() {
  try {
    client = new MongoClient(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    await client.connect();
    logActivity("Info", "Connected to MongoDB");

    const db = getDb();

    // Create text index on 'subject' and 'location' for search
    await executeWithRetry(() =>
      db.collection("lessons").createIndex(
        { subject: "text", location: "text" },
        { default_language: "english" }
      )
    );
    logActivity("Info", "Created search indexes");

    // Load default lessons if less than 10 exist
    const lessonsCount = await executeWithRetry(() =>
      db.collection("lessons").countDocuments()
    );
    if (lessonsCount < 10) {
      const defaultLessonsPath = path.join(__dirname, "defaultLessons.json");
      const defaultLessons = JSON.parse(fs.readFileSync(defaultLessonsPath, "utf8"));
      await executeWithRetry(() => db.collection("lessons").insertMany(defaultLessons.lessons));
      logActivity("Info", "Added default lessons from JSON file");
    }
  } catch (err) {
    logActivity("Error", `Database connection error: ${err.message}`);
    process.exit(1);
  }
}
initializeDatabase();

// Graceful shutdown: close MongoDB client on SIGINT
process.on("SIGINT", async () => {
  logActivity("Info", "Closing database connection...");
  if (client) await client.close();
  process.exit(0);
});

// -------------------------------------
// API Endpoints
// -------------------------------------

// Root endpoint
app.get("/", (req, res) => {
  logActivity("Info", "Root endpoint hit");
  res.send("School Activities API is running");
});

// GET /lessons: return lessons with optional pagination
app.get("/lessons", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const lessons = await executeWithRetry(() =>
      getDb().collection("lessons").find().skip(skip).limit(limit).toArray()
    );
    res.json(lessons);
  } catch (err) {
    logActivity("Error", `Failed to fetch lessons: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch lessons" });
  }
});

// PUT /lessons/:id: update lesson attributes (e.g., spaces, subject, etc.)
app.put("/lessons/:id", async (req, res) => {
  try {
    const updates = req.body;
    if (updates.spaces !== undefined) {
      if (typeof updates.spaces !== "number" || updates.spaces < 0) {
        return res.status(400).json({ error: "Invalid spaces value" });
      }
    }
    delete updates._id;
    const result = await executeWithRetry(() =>
      getDb().collection("lessons").findOneAndUpdate(
        { _id: new ObjectId(req.params.id) },
        { $set: updates },
        { returnDocument: "after" }
      )
    );
    if (!result.value) {
      return res.status(404).json({ error: "Lesson not found" });
    }
    logActivity("Info", `Updated lesson with ID: ${req.params.id}`);
    res.json(result.value);
  } catch (err) {
    logActivity("Error", `Failed to update lesson: ${err.message}`);
    if (err.message.includes("invalid ObjectId")) {
      return res.status(400).json({ error: "Invalid lesson ID format" });
    }
    res.status(500).json({ error: "Failed to update lesson" });
  }
});

// GET /search: perform full-text search on lessons
app.get("/search", async (req, res) => {
  try {
    const query = req.query.q;
    if (!query || typeof query !== "string") {
      logActivity("Warning", "Search query required");
      return res.status(400).json({ error: "Search query required" });
    }
    logActivity("Info", `Search query: ${query}`);

    // If query is numeric, also search price and spaces
    const numericQuery = isNaN(query) ? null : Number(query);
    let searchQuery;
    if (numericQuery !== null) {
      searchQuery = {
        $or: [
          { $text: { $search: query } },
          { price: numericQuery },
          { spaces: numericQuery }
        ]
      };
    } else {
      searchQuery = { $text: { $search: query } };
    }
    const results = await executeWithRetry(() =>
      getDb().collection("lessons").find(searchQuery).toArray()
    );
    logActivity("Info", `Search returned ${results.length} result(s)`);
    res.json(results);
  } catch (err) {
    logActivity("Error", `Search failed: ${err.message}`);
    res.status(500).json({ error: "Search failed" });
  }
});

// POST /orders: place a new order with order validation and update lesson spaces
app.post("/orders", async (req, res) => {
  try {
    const { name, phone, lessons } = req.body;
    if (!name || !/^[A-Za-z\s'-]{2,}$/.test(name.trim())) {
      return res.status(400).json({ error: "Invalid name (minimum 2 letters)" });
    }
    const phoneDigits = phone ? phone.replace(/\D/g, '') : '';
    if (phoneDigits.length < 8) {
      return res.status(400).json({ error: "Invalid phone (minimum 8 digits)" });
    }
    if (!Array.isArray(lessons) || lessons.length === 0) {
      return res.status(400).json({ error: "No lessons selected" });
    }
    const lessonIds = lessons.map(l => new ObjectId(l.lessonId));
    const existingLessons = await executeWithRetry(() =>
      getDb().collection("lessons").find({ _id: { $in: lessonIds } }).toArray()
    );
    if (existingLessons.length !== lessons.length) {
      return res.status(400).json({ error: "One or more lessons not found" });
    }
    // Check available spaces and decrement them accordingly
    for (const orderLesson of lessons) {
      const lessonFound = existingLessons.find(l => l._id.toString() === orderLesson.lessonId);
      if (!lessonFound || lessonFound.spaces < orderLesson.quantity) {
        return res.status(400).json({ error: `Not enough spaces available for lesson ID ${orderLesson.lessonId}` });
      }
      await executeWithRetry(() =>
        getDb().collection("lessons").updateOne(
          { _id: new ObjectId(orderLesson.lessonId) },
          { $inc: { spaces: -orderLesson.quantity } }
        )
      );
    }
    // Create the order document
    const order = {
      name: name.trim(),
      phone: phoneDigits,
      lessons,
      date: new Date(),
      status: "confirmed"
    };
    const result = await executeWithRetry(() =>
      getDb().collection("orders").insertOne(order)
    );
    logActivity("Info", `Order created with ID: ${result.insertedId}`);
    res.status(201).json({ message: "Order created successfully", orderId: result.insertedId });
  } catch (err) {
    logActivity("Error", `Failed to create order: ${err.message}`);
    if (err.message.includes("invalid ObjectId")) {
      return res.status(400).json({ error: "Invalid lesson ID format" });
    }
    res.status(500).json({ error: "Failed to create order" });
  }
});

// GET /orders: fetch orders with optional pagination
app.get("/orders", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const orders = await executeWithRetry(() =>
      getDb().collection("orders").find().skip(skip).limit(limit).toArray()
    );
    res.json(orders);
  } catch (err) {
    logActivity("Error", `Failed to fetch orders: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

// 404 Handler for undefined endpoints
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// General Error Handler
app.use((err, req, res, next) => {
  logActivity("Error", `Server error: ${err.message}`);
  res.status(500).json({ error: "Internal server error" });
});

// -------------------------------------
// Start the Server
// -------------------------------------
app.listen(PORT, () => {
  logActivity("Info", `Server running on port ${PORT}`);
  console.log("Available endpoints:");
  console.log("- GET /lessons?page=&limit=");
  console.log("- GET /search?q=query");
  console.log("- PUT /lessons/:id");
  console.log("- POST /orders");
  console.log("- GET /orders?page=&limit=");
  console.log("- GET /images (to serve images)");
});
