const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// Logger function to log activity with a formatted timestamp
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

// CORS headers to allow any origin and specific headers and methods.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Logger middleware to output all incoming requests.
app.use((req, res, next) => {
  logActivity("Request", `${req.method} ${req.url}`);
  next();
});

// Ensure images directory exists and serve images with a static middleware. 
// If an image file is not found, a 404 error is automatically returned.
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

// Enable JSON request body parsing.
app.use(express.json());

// MongoDB connection setup using the native Node.js driver.
let client;
const uri = process.env.MONGO_URI || "mongodb+srv://wednesday:wednesday@cluster0.2q635.mongodb.net/after_school_activities?retryWrites=true&w=majority";

function getDb() {
  if (!client) throw new Error("Database client not initialized");
  return client.db("after_school_activities");
}

// Helper function to retry MongoDB operations in case of failure.
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

// Initialize the MongoDB connection and the lessons collection.
async function initializeDatabase() {
  try {
    client = new MongoClient(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    await client.connect();
    logActivity("Info", "Connected to MongoDB");

    const db = getDb();
    // Create a text index for full-text search on subject and location.
    await executeWithRetry(() =>
      db.collection("lessons").createIndex(
        { subject: "text", location: "text" },
        { default_language: "english" }
      )
    );
    logActivity("Info", "Created search indexes");

    // Load default lessons if there are fewer than 10 lessons available.
    const lessonsCount = await executeWithRetry(() =>
      db.collection("lessons").countDocuments()
    );
    if (lessonsCount < 10) {
      const defaultLessonsPath = path.join(__dirname, "defaultLessons.json");
      const defaultLessons = JSON.parse(fs.readFileSync(defaultLessonsPath, "utf8"));
      await executeWithRetry(() =>
        db.collection("lessons").insertMany(defaultLessons.lessons)
      );
      logActivity("Info", "Added default lessons from JSON file");
    }
  } catch (err) {
    logActivity("Error", `Database connection error: ${err.message}`);
    process.exit(1);
  }
}
initializeDatabase();

// Graceful shutdown: close MongoDB connection on SIGINT
process.on("SIGINT", async () => {
  logActivity("Info", "Closing database connection...");
  if (client) await client.close();
  process.exit(0);
});

// Root endpoint for basic server status.
app.get("/", (req, res) => {
  logActivity("Info", "Root endpoint hit");
  res.send("School Activities API is running");
});

// GET /lessons: Returns lessons as JSON with optional pagination.
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

// PUT /lessons/:id: Update attributes of a lesson.
// Allows for updating any attribute including available spaces.
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

// GET /search: Full-text search endpoint for lessons.
// Accepts a query parameter "q". If the query is numeric, searches price and spaces as well.
app.get("/search", async (req, res) => {
  const query = (req.query.q || '').trim();
  try {
    if (!query || typeof query !== "string") {
      logActivity("Warning", "Search query required");
      return res.status(400).json({ error: "Search query required" });
    }
    logActivity("Info", `Search query: ${query}`);

    // If the query can be converted to a number, search numeric fields as well.
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

// POST /orders: Place a new order.
// Validates "name" (letters only) and "phone" (numbers only).
// Checks lesson availability and decrements the spaces accordingly.
// Returns a JSON response with a success message that can be used to trigger a popup in the front-end.
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
    // Check available spaces and decrement them accordingly.
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
    // The JSON response includes a confirmation message that front-end developers can use
    // to display a pop-up indicating "Order submitted".
    res.status(201).json({ message: "Order created successfully", orderId: result.insertedId });
  } catch (err) {
    logActivity("Error", `Failed to create order: ${err.message}`);
    if (err.message.includes("invalid ObjectId")) {
      return res.status(400).json({ error: "Invalid lesson ID format" });
    }
    res.status(500).json({ error: "Failed to create order" });
  }
});

// GET /orders: Retrieves a list of orders with optional pagination.
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

// 404 handler for endpoints that are not found.
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// Generic error handler middleware.
app.use((err, req, res, next) => {
  logActivity("Error", `Server error: ${err.message}`);
  res.status(500).json({ error: "Internal server error" });
});

// Start the server and log available endpoints.
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
