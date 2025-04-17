// test-tls-connection.ts
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config();

async function testConnection() {
  console.log("Testing MongoDB connection with TLS options...");
  
  // Get uri from environment but provide a default for testing
  const uri = process.env.MONGODB_URI || 'mongodb+srv://romeobourne211:password@cluster0.kiqbjkt.mongodb.net/';
  console.log("Connection string:", uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@'));
  
 
  const options = {
    connectTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    serverSelectionTimeoutMS: 30000,
    tls: true,
    tlsAllowInvalidCertificates: true, 
    minPoolSize: 0,
    maxPoolSize: 10
  };
  
  try {
    console.log("Connecting with options:", JSON.stringify(options));
    const client = new MongoClient(uri, options);
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