const { MongoClient } = require("mongodb");

require('dotenv').config();

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

async function saveBundle(data) {
  try {
    await client.connect();
    
    const database = client.db("podpre_ai");
    const collection = database.collection("research_bundles");

    // Insert data into the collection
    const result = await collection.insertOne(data);
    console.log(`Data saved with id: ${result.insertedId}`);
  } catch (error) {
    console.error("Error saving data:", error);
  } finally {
    await client.close();
  }
}

export default async function handler(req, res) {
  // Check for the HTTP method if needed, e.g., if it's a POST or GET request
  if (req.method === 'POST') {
    const { guestName, company, topic, urls, context } = req.body;
    const newBundle = {
      guestName,
      company,
      topic,
      urls,
      context,
      processed: false,
      created_date: new Date(), // Add the created_date timestamp
    };
    
    saveBundle(newBundle);

    // Return a JSON response with ok: true
    res.status(200).json({ ok: true });
  } else {
    // Handle other HTTP methods, e.g., if a GET request is made instead of POST
    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}