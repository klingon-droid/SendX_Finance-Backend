import { MongoClient } from 'mongodb';
export declare function connectToDatabase(): Promise<{
    client: MongoClient;
    db: import("mongodb").Db;
}>;
