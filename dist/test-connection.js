"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongodb_1 = require("mongodb");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
async function testConnection() {
    console.log("Testing MongoDB connection...");
    console.log("Connection string:", process.env.MONGODB_URI?.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@'));
    try {
        const client = new mongodb_1.MongoClient(process.env.MONGODB_URI || '');
        await client.connect();
        console.log("Connected successfully!");
        const db = client.db(process.env.MONGODB_DB_NAME || 'test');
        const result = await db.command({ ping: 1 });
        console.log("Ping result:", result);
        await client.close();
        console.log("Connection closed properly");
    }
    catch (error) {
        console.error("Connection failed:", error);
    }
}
testConnection();
