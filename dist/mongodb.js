"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectToDatabase = connectToDatabase;
const mongodb_1 = require("mongodb");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
if (!process.env.MONGODB_URI) {
    throw new Error('Invalid/Missing environment variable: "MONGODB_URI"');
}
const uri = process.env.MONGODB_URI;
const options = {
    serverApi: {
        version: mongodb_1.ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
    connectTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    tls: true,
    tlsAllowInvalidCertificates: true
};
let client;
let clientPromise;
if (process.env.NODE_ENV === 'development') {
    let globalWithMongo = global;
    if (!globalWithMongo._mongoClientPromise) {
        client = new mongodb_1.MongoClient(uri, options);
        globalWithMongo._mongoClientPromise = client.connect();
    }
    clientPromise = globalWithMongo._mongoClientPromise;
}
else {
    client = new mongodb_1.MongoClient(uri, options);
    clientPromise = client.connect();
}
async function connectToDatabase() {
    try {
        console.log('Attempting to connect to MongoDB...');
        const client = await clientPromise;
        const db = client.db(process.env.MONGODB_DB_NAME || 'test');
        console.log("Successfully connected to MongoDB!");
        return { client, db };
    }
    catch (error) {
        console.error('Error connecting to database:', error);
        throw error;
    }
}
