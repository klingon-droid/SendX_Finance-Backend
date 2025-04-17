// test-connection.ts
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config();

async function testConnection() {
  console.log("Testing MongoDB connection...");
  console.log("Connection string:", process.env.MONGODB_URI?.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@'));
  
  try {
    const client = new MongoClient(process.env.MONGODB_URI || '');
    await client.connect();
    console.log("Connected successfully!");
    
    const db = client.db(process.env.MONGODB_DB_NAME || 'test');
    const result = await db.command({ ping: 1 });
    console.log("Ping result:", result);
    
    await client.close();
    console.log("Connection closed properly");
  } catch (error) {
    console.error("Connection failed:", error);
  }
}

testConnection();