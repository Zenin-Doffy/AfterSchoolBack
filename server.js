const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const path = require("path");
const fs = require("fs");
const app = express();
const PORT = process.env.PORT || 3000;

// Logger middleware: log method, URL and timestamp
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Create images directory if it doesn't exist
const imagesDir = path.join(__dirname, "images");
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir);
}

// Static file middleware: serve images from the "images" directory
app.use("/images", express.static(imagesDir, {
  fallthrough: false,
  setHeaders: (res, filePath) => {
    res.set("Cache-Control", "public, max-age=3600");
  }
}));

// New endpoint to list all images in the images directory (for debugging)
app.get("/images-list", (req, res) => {
  fs.readdir(imagesDir, (err, files) => {
    if (err) {
      console.error("Error reading images directory:", err);
      return res.status(500).json({ error: "Unable to read images directory" });
    }
    res.json({ images: files });
  });
});

// CORS middleware: allow requests from any origin
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  next();
});

// Parse JSON bodies
app.use(express.json());

// Database connection using native MongoDB driver
let db;
const uri = "mongodb+srv://wednesday:wednesday@cluster0.2q635.mongodb.net/after_school_activities?retryWrites=true&w=majority";

async function initializeDatabase() {
  try {
    const client = await MongoClient.connect(uri, { 
      useNewUrlParser: true,
      useUnifiedTopology: true 
    });
    
    db = client.db("after_school_activities");
    console.log("Connected to MongoDB");
    
    // Create text index for search on subject and location (if not exists)
    await db.collection("lessons").createIndex(
      { subject: "text", location: "text" },
      { default_language: "english" }
    );
    
    console.log("Created search indexes");
    
    // Load default lessons from the JSON file if there are less than 10 lessons
    const lessonsCount = await db.collection("lessons").countDocuments();
    if (lessonsCount < 10) {
      const defaultLessonsPath = path.join(__dirname, "defaultLessons.json");
      const defaultLessons = JSON.parse(fs.readFileSync(defaultLessonsPath, "utf8"));
      
      await db.collection("lessons").insertMany(defaultLessons.lessons);
      console.log("Added default lessons from JSON file");
    }
  } catch (err) {
    console.error("Database connection error:", err);
    process.exit(1);
  }
}

initializeDatabase();

// Root endpoint
app.get("/", (req, res) => {
  res.send("School Activities API is running");
});

// GET /lessons: return all lessons
app.get("/lessons", async (req, res) => {
  try {
    if (!db) throw new Error("Database not connected");
    const lessons = await db.collection("lessons").find().toArray();
    res.json(lessons);
  } catch (err) {
    console.error("Failed to fetch lessons:", err);
    res.status(500).json({ error: "Failed to fetch lessons" });
  }
});

// PUT /lessons/:id: update lesson attributes (e.g., spaces, subject, etc.)
app.put("/lessons/:id", async (req, res) => {
  try {
    if (!db) throw new Error("Database not connected");
    
    // Get the fields to update from the request body
    const updates = req.body;
    
    // If "spaces" is provided, validate that it is a non-negative number
    if (updates.spaces !== undefined) {
      if (typeof updates.spaces !== "number" || updates.spaces < 0) {
        return res.status(400).json({ error: "Invalid spaces value" });
      }
    }
    
    // Remove _id if present (to prevent updating the document's _id)
    delete updates._id;
    
    // Update the lesson document with all provided attributes
    const result = await db.collection("lessons").findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updates },
      { returnDocument: "after" }
    );
    
    if (!result.value) {
      return res.status(404).json({ error: "Lesson not found" });
    }
    
    res.json(result.value);
  } catch (err) {
    console.error("Failed to update lesson:", err);
    if (err.message.includes("invalid ObjectId")) {
      return res.status(400).json({ error: "Invalid lesson ID format" });
    }
    res.status(500).json({ error: "Failed to update lesson" });
  }
});

// GET /search: perform full-text search on lessons
app.get("/search", async (req, res) => {
  try {
    if (!db) throw new Error("Database not connected");
    const query = req.query.q;
    
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Search query required" });
    }
    
    // If query is numeric, also search on price and spaces
    const numericQuery = isNaN(query) ? null : Number(query);
    const searchConditions = [
      { subject: { $regex: query, $options: "i" } },
      { location: { $regex: query, $options: "i" } }
    ];
    
    if (numericQuery !== null) {
      searchConditions.push({ price: numericQuery });
      searchConditions.push({ spaces: numericQuery });
    }
    
    const results = await db.collection("lessons").find({
      $or: searchConditions
    }).toArray();
    
    res.json(results);
  } catch (err) {
    console.error("Search failed:", err);
    res.status(500).json({ error: "Search failed" });
  }
});

// POST /orders: save a new order (without modifying lesson spaces again)
app.post("/orders", async (req, res) => {
  try {
    if (!db) throw new Error("Database not connected");
    const { name, phone, lessons } = req.body;
    
    // Validate name (only letters, spaces, hyphens or apostrophes, minimum 2 characters)
    if (!name || !/^[A-Za-z\s'-]{2,}$/.test(name.trim())) {
      return res.status(400).json({ error: "Invalid name (minimum 2 letters)" });
    }
    
    // Validate phone (digits only, minimum 8 digits)
    const phoneDigits = phone ? phone.replace(/\D/g, '') : '';
    if (phoneDigits.length < 8) {
      return res.status(400).json({ error: "Invalid phone (minimum 8 digits)" });
    }
    
    // Validate lessons array
    if (!Array.isArray(lessons) || lessons.length === 0) {
      return res.status(400).json({ error: "No lessons selected" });
    }
    
    // Verify that all requested lessons exist and have enough spaces
    const lessonIds = lessons.map(l => new ObjectId(l.lessonId));
    const existingLessons = await db.collection("lessons")
      .find({ _id: { $in: lessonIds } })
      .toArray();
    
    if (existingLessons.length !== lessons.length) {
      return res.status(400).json({ error: "One or more lessons not found" });
    }
    
    // Check that each lesson has enough available spaces for the requested quantity
    for (const orderLesson of lessons) {
      const lessonFound = existingLessons.find(l => l._id.toString() === orderLesson.lessonId);
      if (!lessonFound || lessonFound.spaces < orderLesson.quantity) {
        return res.status(400).json({ error: `Not enough spaces available for lesson ID ${orderLesson.lessonId}` });
      }
    }
    
    // Create the order document without updating lesson spaces (they were already updated when added to cart)
    const order = {
      name: name.trim(),
      phone: phoneDigits,
      lessons,
      date: new Date(),
      status: "confirmed"
    };
    
    const result = await db.collection("orders").insertOne(order);
    
    res.status(201).json({ 
      message: "Order created successfully",
      orderId: result.insertedId
    });
  } catch (err) {
    console.error("Failed to create order:", err);
    if (err.message.includes("invalid ObjectId")) {
      return res.status(400).json({ error: "Invalid lesson ID format" });
    }
    res.status(500).json({ error: "Failed to create order" });
  }
});

// 404 handler for undefined endpoints
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// General error handler
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log("Available endpoints:");
  console.log("- GET /lessons");
  console.log("- GET /search?q=query");
  console.log("- PUT /lessons/:id");
  console.log("- POST /orders");
  console.log("- GET /images-list  (Lists available images)");
});

// Graceful shutdown on SIGINT
process.on("SIGINT", async () => {
  console.log("Shutting down server...");
  process.exit(0);
});
