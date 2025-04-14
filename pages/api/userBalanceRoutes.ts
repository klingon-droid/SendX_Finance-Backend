
import { Request, Response } from 'express';

import { connectToDatabase } from '../../mongodb';

// GET endpoint to fetch a user's balance
export async function getUserBalance(req: Request, res: Response) {
  try {
    const { username } = req.query;
    if (!username) {
      return res.status(400).json({ 
        message: 'Missing username',
        error: 'Username parameter is required'
      });
    }
    
    const { db } = await connectToDatabase();
    const usersCollection = db.collection('users');
    const user = await usersCollection.findOne({ username });
    
    if (!user) {
      return res.status(404).json({ 
        message: 'User not found',
        data: null
      });
    }
    
    return res.status(200).json({
      message: 'User balance found',
      data: {
        balance: user.balance || 0
      }
    });
  } catch (error) {
    console.error('Error fetching user balance:', error);
    return res.status(500).json({ 
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'An unexpected error occurred'
    });
  }
}

// POST endpoint to update a user's balance
export async function updateUserBalance(req: Request, res: Response) {
  try {
    const { username, balance } = req.body;
    
    if (!username || balance === undefined) {
      return res.status(400).json({ 
        message: 'Missing required fields',
        error: 'Username and balance are required'
      });
    }
    
    const { db } = await connectToDatabase();
    const usersCollection = db.collection('users');
    
    // Update user if exists, or create new user
    const result = await usersCollection.updateOne(
      { username },
      { $set: { balance } },
      { upsert: true }
    );
    
    return res.status(200).json({
      message: result.upsertedCount ? 'User created with balance' : 'User balance updated',
      data: { username, balance }
    });
  } catch (error) {
    console.error('Error updating user balance:', error);
    return res.status(500).json({ 
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'An unexpected error occurred'
    });
  }
}