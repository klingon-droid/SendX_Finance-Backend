import { Request, Response } from 'express';
import { connectToDatabase } from '../../mongodb';
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { clusterApiUrl, Connection } from '@solana/web3.js';
import { PrivyClient } from '@privy-io/server-auth';
import { Keypair } from '@solana/web3.js';

export async function withdrawHandler(req: Request, res: Response) {
  console.log('Received withdrawal request:', {
    method: req.method,
    body: req.body
  });

  if (req.method !== 'POST') {
    console.log('Invalid method:', req.method);
    return res.status(405).json({ 
      message: 'Method not allowed',
      error: 'Only POST requests are allowed'
    });
  }

  try {
    const { username, amount, recipientAddress, walletAddress } = req.body;
    console.log('Parsed request body:', { username, amount, recipientAddress, walletAddress });

    if (!username || !amount || !recipientAddress || !walletAddress) {
      console.log('Missing required fields:', { username, amount, recipientAddress, walletAddress });
      return res.status(400).json({ 
        message: 'Missing required fields',
        error: 'Username, amount, recipient address, and wallet address are required'
      });
    }

    // Connect to MongoDB
    const { db } = await connectToDatabase();
    const usersCollection = db.collection('users');

    // Get user's current balance
    const user = await usersCollection.findOne({ username });
    if (!user) {
      return res.status(404).json({ 
        message: 'User not found',
        error: 'User does not exist in the database'
      });
    }

    // Check if user has sufficient balance
    if (user.balance < amount) {
      return res.status(400).json({ 
        message: 'Insufficient balance',
        error: 'User does not have enough SOL to withdraw'
      });
    }

    // Initialize Privy client with correct environment variables
    const privyClient = new PrivyClient(
      process.env.PRIVY_CLIENT_ID!,
      process.env.PRIVY_CLIENT_SECRET!
    );

    // Get user's Privy wallet
    const privyUser = await privyClient.getUserByTwitterUsername(username);
    if (!privyUser?.wallet?.address) {
      return res.status(404).json({ 
        message: 'Wallet not found',
        error: 'User does not have a wallet associated with their account'
      });
    }

    // Verify that the provided wallet address matches the Privy wallet
    if (privyUser.wallet.address !== walletAddress) {
      return res.status(400).json({
        message: 'Invalid wallet address',
        error: 'Provided wallet address does not match user\'s Privy wallet'
      });
    }

    // Create Solana connection
    const connection = new Connection(clusterApiUrl("mainnet-beta"), "confirmed");

    try {
      // Get the user's wallet balance
      const walletBalance = await connection.getBalance(new PublicKey(walletAddress));
      const walletBalanceInSol = walletBalance / LAMPORTS_PER_SOL;

      // Only check if wallet has enough SOL for transaction fees (approximately 0.000005 SOL)
      const MINIMUM_FEE_BALANCE = 0.00001; // 0.00001 SOL should be more than enough for fees
      
      console.log(`[withdrawHandler inner try] Detailed balance check:`, {
        walletBalanceInLamports: walletBalance,
        walletBalanceInSol,
        requestedAmount: amount,
        minimumFeeBalance: MINIMUM_FEE_BALANCE,
        comparison: walletBalanceInSol < MINIMUM_FEE_BALANCE
      });

      if (walletBalanceInSol < MINIMUM_FEE_BALANCE) {
        console.log(`[withdrawHandler inner try] Balance check failed:`, {
          currentBalance: walletBalanceInSol,
          requiredBalance: MINIMUM_FEE_BALANCE,
          difference: MINIMUM_FEE_BALANCE - walletBalanceInSol
        });
        return res.status(400).json({ 
          message: 'Insufficient wallet balance',
          error: 'Your wallet needs at least 0.00001 SOL to cover transaction fees'
        });
      }

      // Create and sign the transaction
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: new PublicKey(walletAddress),
          toPubkey: new PublicKey(recipientAddress),
          lamports: amount * LAMPORTS_PER_SOL,
        })
      );

      // Get the latest blockhash and calculate fees
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = new PublicKey(walletAddress);
      
      // Calculate transaction fee
      const fee = await connection.getFeeForMessage(transaction.compileMessage());
      const feeInSol = typeof fee === 'number' ? fee / LAMPORTS_PER_SOL : 0;
      console.log(`[withdrawHandler inner try] Transaction fee details:`, {
        feeInLamports: fee,
        feeInSol,
        blockhash,
        lastValidBlockHeight
      });

      // Get the wallet's private key from environment variables
      const walletPrivateKey = process.env.SOLANA_PRIVATE_KEY;
      if (!walletPrivateKey) {
        throw new Error('Wallet private key not found in environment variables');
      }

      // Create keypair from private key
      const senderKeypair = Keypair.fromSecretKey(
        Buffer.from(walletPrivateKey, 'base64')
      );

      // Sign and send the transaction
      const signature = await connection.sendTransaction(transaction, [senderKeypair]);

      // Confirm the transaction
      await connection.confirmTransaction(signature);

      // Update user's balance in the database
      const newBalance = user.balance - amount;
      await usersCollection.updateOne(
        { username },
        { $set: { balance: newBalance } }
      );

      // Create Solscan URL
      const solscanUrl = `https://solscan.io/tx/${signature}`;

      return res.status(200).json({
        message: 'Withdrawal successful',
        data: {
          signature,
          newBalance,
          solscanUrl,
          transactionDetails: {
            amount,
            recipientAddress,
            timestamp: new Date().toISOString()
          }
        }
      });
    } catch (error) {
      console.error('Error processing withdrawal:', error);
      return res.status(500).json({ 
        message: 'Failed to process withdrawal',
        error: error instanceof Error ? error.message : 'Unknown error occurred during withdrawal'
      });
    }
  } catch (error) {
    console.error('Error in withdrawal handler:', error);
    return res.status(500).json({ 
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'An unexpected error occurred'
    });
  }
} 