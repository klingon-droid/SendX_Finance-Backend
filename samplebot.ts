import Redis from 'ioredis';
import { Scraper, SearchMode } from 'agent-twitter-client';
// @ts-ignore: no declaration file for module 'node-cron'
import cron from 'node-cron';
import { onchainAction } from './onChainAction';
import { getUsername } from './username';
import { PrivyClient } from '@privy-io/server-auth';
import dotenv from 'dotenv';
import { Ollama } from "@langchain/ollama";
import { ChatGroq } from "@langchain/groq";
import axios from 'axios';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { connectToDatabase } from './mongodb';
import { v4 as uuidv4 } from 'uuid';
import { getUserBalance, updateUserBalance } from './pages/api/userBalanceRoutes';
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, clusterApiUrl, Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

dotenv.config();

const MAX_RETRIES = 5;
const RETRY_DELAY = 5000;

async function reconnectWithRetry(service: string, connectFn: () => Promise<any>): Promise<any> {
    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            console.log(`Attempting to reconnect to ${service} (attempt ${i + 1}/${MAX_RETRIES})`);
            return await connectFn();
        } catch (error) {
            console.error(`Failed to reconnect to ${service}:`, error);
            if (i < MAX_RETRIES - 1) {
                console.log(`Waiting ${RETRY_DELAY}ms before next retry...`);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            } else {
                throw new Error(`Failed to reconnect to ${service} after ${MAX_RETRIES} attempts`);
            }
        }
    }
}

// --- Global Error Handlers (Add these VERY FIRST) ---
process.on('uncaughtException', (err, origin) => {
  console.error(`
========================================
PROCESS ENCOUNTERED UNCAUGHT EXCEPTION
========================================
Error:`, err);
  console.error('Origin:', origin);
  console.error('Exiting process...');
  process.exit(1); // Exit on uncaught exception
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`
=============================================
PROCESS ENCOUNTERED UNHANDLED REJECTION
=============================================
Reason:`, reason);
  console.error('At promise:', promise);
  // Recommended: Log the error but DO NOT necessarily exit. 
  // Depending on the app, you might want to attempt recovery or just log.
  // For debugging, we might exit to make it obvious:
  // process.exit(1);
});
// --- End Global Error Handlers ---

dotenv.config();

const app = express();
console.log('[Server Setup] Express app initialized.'); 

const port = process.env.PORT || 3005;

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));


app.use((req, res, next) => {
  if (req.path === '/api/withdraw') {
    console.log(`[Middleware Logger] Received request: ${req.method} ${req.path}`);
  }
  next();
});

app.use(express.json());

// Explicitly handle OPTIONS requests for the withdraw endpoint BEFORE the POST handler
app.options('/api/withdraw', cors()); 
interface Tweet {
    id: string;
    conversationId: string;
    mentions: string[];
    name: string;
    permanentUrl: string;
    text: string;
    userId: string;
    username: string;
    isQuoted: boolean;
    isReply: boolean;
    isRetweet: boolean;
    isPin: boolean;
    timeParsed: string;
    timestamp: number;
    html: string;
}

interface UserBalance {
    data: {
        balance: number;
    } | null;
}

interface UserProfile {
    userId: string;
    name: string;
    username: string;
}

const redis = new Redis({
    host: process.env.REDIS_HOST || '',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    username: process.env.REDIS_USERNAME || '',
    password: process.env.REDIS_PASSWORD || '',
    tls: {
        rejectUnauthorized: false
    }
});

const LAST_REPLIED_TWEET_KEY = 'lastRepliedTweetId';

// async function loadLastRepliedTweetId(): Promise<string | null> {
//     return await redis.get(LAST_REPLIED_TWEET_KEY);
// }

// async function saveLastRepliedTweetId(tweetId: string): Promise<void> {
//     await redis.set(LAST_REPLIED_TWEET_KEY, tweetId);
// }

async function withdrawHandler(req: Request, res: Response) {
    console.log('[withdrawHandler] Entered function.'); // Log entry
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
  
      // --- Revert Step 1 & 3: Find user in DB by username FIRST ---
      console.log('[withdrawHandler] Connecting to database...'); // Log before DB connect
      const { db } = await connectToDatabase();
      const usersCollection = db.collection('users');
      console.log('[withdrawHandler] Database connected.'); // Log after DB connect
  
      console.log(`[withdrawHandler] Finding user: ${username}`); // Log before DB find (using username)
      const user = await usersCollection.findOne({ username }); // <<< REVERTED LOOKUP
      if (!user) {
        console.log('[withdrawHandler] User not found.'); // Log user not found
        console.log('[withdrawHandler] Sending 404 response (User not found)...');
        return res.status(404).json({
          message: 'User not found',
          error: 'User does not exist in the database' // Original error message
        });
      }
      console.log(`[withdrawHandler] User found in DB. Balance: ${user.balance}`); // Log user found

      // --- Revert Step 4: Check DB Balance ---
      if (user.balance < amount) {
        console.log('[withdrawHandler] Insufficient balance.'); // Log insufficient balance
        console.log('[withdrawHandler] Sending 400 response (Insufficient balance)...');
        return res.status(400).json({
          message: 'Insufficient balance',
          error: 'User does not have enough deposited SOL to withdraw' // Original message
        });
      }
      console.log('[withdrawHandler] User has sufficient balance.');

      // --- Revert Step 1 & 2: Get Privy User and Verify Wallet AFTER DB lookup ---
      console.log('[withdrawHandler] Initializing Privy client...'); // Log before Privy init
      const privyClient = new PrivyClient(
        process.env.PRIVY_CLIENT_ID!,
        process.env.PRIVY_CLIENT_SECRET!
      );
      console.log('[withdrawHandler] Privy client initialized.'); // Log after Privy init

      console.log(`[withdrawHandler] Getting Privy user by Twitter username: ${username}`); // Log before Privy getUser
      const privyUser = await privyClient.getUserByTwitterUsername(username);
      // Check if Privy user exists and has a wallet
      if (!privyUser?.wallet?.address) {
        console.log('[withdrawHandler] Privy user or wallet not found.'); // Log Privy user/wallet not found
        console.log('[withdrawHandler] Sending 404 response (Wallet not found)...');
        return res.status(404).json({
          message: 'Wallet not found',
          error: 'User does not have a wallet associated with their Privy account' // Adjusted message
        });
      }
      console.log(`[withdrawHandler] Privy user found. Wallet Address: ${privyUser.wallet.address}`); // Log Privy user found

      // Verify that the provided wallet address matches the Privy wallet
      if (privyUser.wallet.address !== walletAddress) {
        console.log('[withdrawHandler] Provided wallet address does not match Privy wallet.'); // Log address mismatch
        console.log('[withdrawHandler] Sending 400 response (Invalid wallet address)...');
        return res.status(400).json({
          message: 'Invalid wallet address',
          error: 'Provided wallet address does not match user\\\'s Privy wallet'
        });
      }
      console.log('[withdrawHandler] Provided wallet address matches Privy wallet.');

      // --- Step 5: Solana Transaction Logic (largely unchanged) ---
      console.log('[withdrawHandler] Connecting to Solana devnet...');
      const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
      console.log('[withdrawHandler] Solana connection established.'); // Log after Solana connection
  
      // --- Start of inner try block for Solana interaction ---
      try {
        console.log(`[withdrawHandler inner try] Checking balance for wallet: ${walletAddress}`); // Log before getBalance
        const walletBalance = await connection.getBalance(new PublicKey(walletAddress));
        const walletBalanceInSol = walletBalance / LAMPORTS_PER_SOL;
        console.log(`[withdrawHandler inner try] Wallet balance: ${walletBalanceInSol} SOL`); // Log balance result
  
        // Only check if wallet has enough SOL for transaction fees (approximately 0.000005 SOL)
        const MINIMUM_FEE_BALANCE = 0.00001; // 0.00001 SOL should be more than enough for fees
        if (walletBalanceInSol < MINIMUM_FEE_BALANCE) {
          console.log('[withdrawHandler inner try] Insufficient wallet balance for fees.'); // Log insufficient wallet balance
          console.log('[withdrawHandler inner try] Sending 400 response (Insufficient wallet balance)...');
          return res.status(400).json({ 
            message: 'Insufficient wallet balance',
            error: 'Your wallet needs at least 0.00001 SOL to cover transaction fees'
          });
        }
  
        console.log('[withdrawHandler inner try] Creating Solana transaction...'); // Log before Tx creation
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
        transaction.feePayer = new PublicKey(walletAddress); // User pays their own fees
        
        // Calculate transaction fee
        const fee = await connection.getFeeForMessage(transaction.compileMessage());
        const feeInSol = typeof fee === 'number' ? fee / LAMPORTS_PER_SOL : 0;
        console.log(`[withdrawHandler inner try] Transaction fee details:`, {
          feeInLamports: fee,
          feeInSol,
          blockhash,
          lastValidBlockHeight,
          feePayer: walletAddress
        });

        // Return the serialized transaction to the frontend for user signing
        const serializedTransaction = transaction.serialize({
          requireAllSignatures: false,
          verifySignatures: false
        }).toString('base64');

        return res.status(200).json({
          message: 'Transaction ready for signing',
          data: {
            transaction: serializedTransaction,
            fee: feeInSol,
            transactionDetails: {
              amount,
              recipientAddress,
              timestamp: new Date().toISOString()
            }
          }
        });
      } catch (error) {
        console.error('Error processing withdrawal:', error);
        // Log before sending error response
        console.log('[withdrawHandler inner catch] Sending 500 response...');
        return res.status(500).json({ 
          message: 'Failed to process withdrawal',
          error: error instanceof Error ? error.message : 'Unknown error occurred during withdrawal'
        });
      }
    } catch (error) {
      console.error('Error in withdrawHandler (outer catch):', error);
      // Log before sending error response
      console.log('[withdrawHandler outer catch] Sending 500 response...');
      return res.status(500).json({ 
        message: 'Internal server error',
        error: error instanceof Error ? error.message : 'An unexpected error occurred'
      });
    }
}



app.post('/api/withdraw', async (req: Request, res: Response) => {
  console.log('[POST /api/withdraw] Route handler entered.'); // Log route entry
  try {
    console.log('[POST /api/withdraw] Calling withdrawHandler...'); // Log before calling handler
    await withdrawHandler(req, res);
    console.log('[POST /api/withdraw] withdrawHandler finished.'); // Log after handler finishes (if successful)
  } catch (error) {
    console.error('Error in withdraw handler route catch block:', error); // Log error caught at route level
    // Log before sending error response
    console.log('[POST /api/withdraw catch] Sending 500 response...');
    res.status(500).json({
      message: 'Internal server error in route',
      error: error instanceof Error ? error.message : 'An unexpected error occurred in route'
    });
  }
});

// @ts-ignore - TypeScript error workaround
app.get('/api/userBalance', async (req, res) => {
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
});

// @ts-ignore - TypeScript error workaround
app.post('/api/userBalance', async (req, res) => {
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
});

app.get('/health', async (req: express.Request, res: express.Response) => {
    try {
        // Check MongoDB connection
        const { db } = await connectToDatabase();
        await db.command({ ping: 1 });

        // Check Redis connection
        await redis.ping();

        // Check memory usage
        const memoryUsage = process.memoryUsage();
        const memoryThreshold = 450 * 1024 * 1024; // 450MB threshold (below 512MB limit)

        const status = {
            status: 'ok',
            timestamp: new Date().toISOString(),
            services: {
                mongodb: 'connected',
                redis: 'connected'
            },
            memory: {
                heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + 'MB',
                rss: Math.round(memoryUsage.rss / 1024 / 1024) + 'MB',
                warning: memoryUsage.rss > memoryThreshold ? 'High memory usage' : null
            }
        };

        res.json(status);
    } catch (error) {
        console.error('Health check failed:', error);
        res.status(500).json({
            status: 'error',
            timestamp: new Date().toISOString(),
            error: error.message
        });
    }
});

// Modified replyToTweet function to generate approval links
async function replyToTweet(
  scraper: Scraper,
  tweet: Tweet,
  privyClient: PrivyClient,
  llm: ChatGroq | Ollama
): Promise<void> {
  try {
    console.log(tweet);
    const tweetText = tweet.text;
    const sender = tweet.username;
    const myUsername = process.env.MY_USERNAME;

    // IMPORTANT: Skip processing if the sender is the bot itself
    if (sender.toLowerCase() === myUsername?.toLowerCase()) {
      console.log(`Skipping tweet ${tweet.id} because it's from our own bot`);
      return;
    }

    // Skip if it's a retweet or quote - only process direct mentions
    if (tweet.isRetweet || tweet.isQuoted) {
      console.log(`Skipping tweet ${tweet.id} because it's a retweet or quote`);
      return;
    }

    // Parse tweet to get recipient and amount
    const result = await getUsername(tweetText, llm, scraper, tweet.id);
    if (!result) {
      console.log("Could not parse username and amount");
      await scraper.sendTweet(`@${sender} Please format your request as "@${myUsername} send 0.1 to @recipient"`, tweet.id);
      return;
    }
      
    const { username: recipientUsername, amount } = result;
    console.log('Recipient Username:', recipientUsername);
    console.log('Amount:', amount);

    // Additional validation to avoid loops: Don't process if recipient is the bot itself
    if (recipientUsername.toLowerCase() === myUsername?.toLowerCase()) {
      console.log(`Skipping tweet ${tweet.id} because recipient is our own bot`);
      await scraper.sendTweet(`@${sender} I cannot send SOL to myself. Please specify a different recipient.`, tweet.id);
      return;
    }

    // Check if recipient exists and has a wallet
    let recipientUser = await privyClient.getUserByTwitterUsername(recipientUsername);
    let isNewUser = false;
      
    // If recipient doesn't exist, import them
    if (!recipientUser) {
      console.log('Recipient user not found on Privy, attempting to import:', recipientUsername);
      const userDetails = await scraper.getProfile(recipientUsername) as UserProfile;
      if (!userDetails?.userId || !userDetails?.username) {
        console.log('Could not fetch recipient details from Twitter');
        await scraper.sendTweet(`@${sender} Could not fetch details for @${recipientUsername}`, tweet.id);
        return;
      }
          
      try {
        recipientUser = await privyClient.importUser({
          linkedAccounts: [
            {
              type: 'twitter_oauth',
              subject: userDetails.userId,
              name: userDetails.name || null,
              username: userDetails.username || null,
            }
          ],
          createSolanaWallet: true,
          customMetadata: {
            username: userDetails.username
          }
        });
        isNewUser = true;
        console.log('Successfully imported recipient user to Privy:', recipientUsername);
      } catch (importError) {
        console.error('Error importing recipient user to Privy:', importError);
        await scraper.sendTweet(`@${sender} Error setting up recipient @${recipientUsername}`, tweet.id);
        return;
      }
    }

    if (!recipientUser?.wallet?.address) {
      console.log('Recipient user wallet not found (Privy):', recipientUsername);
      await scraper.sendTweet(`@${sender} Could not find or create wallet for @${recipientUsername}`, tweet.id);
      return;
    }

    // Generate a unique transaction ID
    const transactionId = uuidv4();
      
    // Store the transaction intent
    const { db } = await connectToDatabase();
    const transactionsCollection = db.collection('transactions');

    console.log(sender, recipientUsername);
      
    await transactionsCollection.insertOne({
      id: transactionId,
      tweetId: tweet.id,
      sender: sender,
      recipient: recipientUsername,
      recipientAddress: recipientUser.wallet.address,
      amount: amount,
      status: 'pending',
      createdAt: new Date(),
      // Set expiry time - transactions expire after 24 hours
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) 
    });
      
    // Create an approval link
    const approvalUrl = `${process.env.FRONTEND_URL}/approve/${transactionId}`;
      
    // Reply with the approval link
    await scraper.sendTweet(
      `@${sender} Ready to send ${amount} SOL to @${recipientUsername}. ` +
      `Click here to approve this transaction: ${approvalUrl} ` +
      `(Link expires in 24 hours)`, 
      tweet.id
    );
      
    console.log(`Created transaction intent ${transactionId} for ${sender} to send ${amount} SOL to ${recipientUsername}`);
  } catch (error) {
    console.error('Error in replyToTweet function for tweet ID:', tweet.id, error);
    try {
      await scraper.sendTweet(`@${tweet.username} Sorry, an error occurred processing your request.`, tweet.id);
    } catch (sendError) {
      console.error('Failed to send error message tweet:', sendError);
    }
  }
}

// Add the transaction API endpoints inline
app.get('/api/transactions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!id) {
      res.status(400).json({ success: false, error: 'Transaction ID is required' });
      return;
    }
    
    const { db } = await connectToDatabase();
    const transactionsCollection = db.collection('transactions');
    
    const transaction = await transactionsCollection.findOne({ id });
    
    if (!transaction) {
      res.status(404).json({ success: false, error: 'Transaction not found' });
      return;
    }
    
    // Check if transaction has expired
    if (transaction.expiresAt && new Date() > new Date(transaction.expiresAt)) {
      res.status(410).json({ success: false, error: 'Transaction has expired' });
      return;
    }
    
    res.status(200).json({
      success: true,
      transaction: {
        id: transaction.id,
        sender: transaction.sender,
        recipient: transaction.recipient,
        recipientAddress: transaction.recipientAddress,
        amount: transaction.amount,
        status: transaction.status
      }
    });
  } catch (error) {
    console.error('Error getting transaction details:', error);
    res.status(500).json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'An unexpected error occurred' 
    });
  }
});

app.post('/api/transactions/complete', async (req, res) => {
  try {
    const { id, signature, senderAddress } = req.body;
    
    if (!id || !signature || !senderAddress) {
      res.status(400).json({ 
        success: false, 
        error: 'Transaction ID, signature, and sender address are required' 
      });
      return;
    }
    
    const { db } = await connectToDatabase();
    const transactionsCollection = db.collection('transactions');
    
    const transaction = await transactionsCollection.findOne({ id });
    
    if (!transaction) {
      res.status(404).json({ success: false, error: 'Transaction not found' });
      return;
    }
    
    if (transaction.status !== 'pending') {
      res.status(400).json({ success: false, error: 'Transaction is no longer pending' });
      return;
    }
    
    // Check if transaction has expired
    if (transaction.expiresAt && new Date() > new Date(transaction.expiresAt)) {
      res.status(410).json({ success: false, error: 'Transaction has expired' });
      return;
    }
    
    // Update transaction status
    await transactionsCollection.updateOne(
      { id },
      { 
        $set: { 
          status: 'completed', 
          signature, 
          senderAddress,
          completedAt: new Date() 
        }
      }
    );
    
    // Send confirmation tweet
    try {
      const scraper = new Scraper();
      await scraper.login(
        process.env.MY_USERNAME || '',
        process.env.PASSWORD || '',
        process.env.EMAIL || ''
      );
      
      const solscanUrl = `https://solscan.io/tx/${signature}`;
      const claimUrl = `${process.env.FRONTEND_URL}`;
      await scraper.sendTweet(
        `@${transaction.sender} You've successfully sent ${transaction.amount} SOL to @${transaction.recipient}. ` +
        `Tx: ${solscanUrl} \n\n` +
        `@${transaction.recipient} You've received ${transaction.amount} SOL! Visit ${claimUrl} to claim your SOL.`, 
        transaction.tweetId
      );
    } catch (twitterError) {
      console.error('Error sending confirmation tweet:', twitterError);
      // Continue even if Twitter notification fails
    }
    
    res.status(200).json({ 
      success: true,
      message: 'Transaction completed successfully',
      data: {
        signature,
        solscanUrl: `https://solscan.io/tx/${signature}`
      }
    });
  } catch (error) {
    console.error('Error completing transaction:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'An unexpected error occurred'
    });
  }
});

// Add after the imports
function checkMemoryUsage() {
    const memoryUsage = process.memoryUsage();
    const memoryThreshold = 450 * 1024 * 1024; // 450MB threshold
    
    if (memoryUsage.rss > memoryThreshold) {
        console.warn('High memory usage detected:', {
            heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`,
            rss: `${Math.round(memoryUsage.rss / 1024 / 1024)}MB`
        });
        
        // Force garbage collection if available
        if (global.gc) {
            console.log('Forcing garbage collection...');
            global.gc();
        }
    }
}

async function main(scraper: Scraper, privyClient: PrivyClient, llm: ChatGroq | Ollama): Promise<void> {
  try {
    const myUsername = process.env.MY_USERNAME;
    if (!myUsername) {
      console.error("MY_USERNAME environment variable not set!");
      return;
    }
        
    console.log(`Fetching tweets mentioning @${myUsername}...`);
    const getTweets = await scraper.fetchSearchTweets(
      `@${myUsername}`,
      20,
      SearchMode.Latest
    );
    console.log(`Seen ${getTweets.tweets.length} tweets.`);

    const formattedTweets = getTweets.tweets.map((tweet: any): Tweet => ({
      id: tweet.id_str || tweet.id,
      conversationId: tweet.conversation_id_str || tweet.conversationId,
      mentions: tweet.entities?.user_mentions?.map((m: any) => m.screen_name) || tweet.mentions || [],
      name: tweet.user?.name || tweet.name,
      permanentUrl: `https://twitter.com/${tweet.user?.screen_name || tweet.username}/status/${tweet.id_str || tweet.id}`,
      text: tweet.full_text || tweet.text,
      userId: tweet.user?.id_str || tweet.userId,
      username: tweet.user?.screen_name || tweet.username,
      isQuoted: tweet.is_quote_status || tweet.isQuoted || false,
      isReply: !!tweet.in_reply_to_status_id_str || tweet.isReply || false,
      isRetweet: !!tweet.retweeted_status || tweet.isRetweet || false,
      isPin: tweet.user?.pinned_tweet_ids_str?.includes(tweet.id_str) || tweet.isPin || false,
      timeParsed: tweet.created_at ? new Date(tweet.created_at).toISOString() : new Date().toISOString(),
      timestamp: tweet.created_at ? new Date(tweet.created_at).getTime() / 1000 : Date.now() / 1000,
      html: tweet.html || ''
    }));

    if (formattedTweets.length > 0) {
      const lastRepliedTweetId = await loadLastRepliedTweetId();
      console.log('Last replied tweet ID from Redis:', lastRepliedTweetId);

      const lastRepliedTweetIdNum = lastRepliedTweetId ? BigInt(lastRepliedTweetId) : BigInt(0);
      let latestProcessedTweetId = lastRepliedTweetIdNum;

      // Sort tweets by timestamp (oldest first) for proper processing order
      formattedTweets.sort((a, b) => a.timestamp - b.timestamp);
      
      // First track all seen tweets to update our ID marker even if we don't reply
      for (const tweet of formattedTweets) {
        const tweetIdNum = BigInt(tweet.id);
        if (tweetIdNum > latestProcessedTweetId) {
          latestProcessedTweetId = tweetIdNum;
        }
      }

      // Create a set of tweets we've already processed to avoid duplicates
      // in case the Twitter API returns the same tweet twice
      const processedTweetIds = new Set<string>();

      for (const tweet of formattedTweets) {
        const tweetIdNum = BigInt(tweet.id);
        console.log(`Processing tweet ID: ${tweet.id} (Num: ${tweetIdNum})`);
        
        // Skip if this tweet has already been processed in this batch
        if (processedTweetIds.has(tweet.id)) {
          console.log(`Tweet ${tweet.id} was already processed in this batch, skipping.`);
          continue;
        }
        
        // Skip tweets from the bot itself to prevent infinite loops
        if (tweet.username.toLowerCase() === myUsername.toLowerCase()) {
          console.log(`Tweet ${tweet.id} is from our own bot, skipping.`);
          processedTweetIds.add(tweet.id);
          continue;
        }

        if (tweetIdNum > lastRepliedTweetIdNum) {
          // Only process if it's a direct mention and not a retweet/quote
          if (tweet.text.toLowerCase().includes(`@${myUsername.toLowerCase()}`) && 
              !tweet.isRetweet && 
              !tweet.isQuoted) {
            console.log(`Tweet ${tweet.id} is a valid mention. Replying...`);
            try {
              await replyToTweet(scraper, tweet, privyClient, llm);
              console.log('Successfully processed and replied to tweet ID:', tweet.id);
              processedTweetIds.add(tweet.id);
            } catch (replyError) {
              console.error('Error replying to tweet ID:', tweet.id, replyError);
            }
          } else {
            console.log(`Tweet ${tweet.id} does not qualify for a reply (retweet, quote, or not direct mention).`);
            processedTweetIds.add(tweet.id);
          }
        } else {
          console.log(`Tweet ID ${tweet.id} is older than or same as last replied (${lastRepliedTweetId}), skipping.`);
          processedTweetIds.add(tweet.id);
        }
      }
            
      // Always update the latest processed tweet ID, even if we didn't reply to any
      if (latestProcessedTweetId > lastRepliedTweetIdNum) {
        console.log(`Updating last replied tweet ID in Redis to: ${latestProcessedTweetId.toString()}`);
        await saveLastRepliedTweetId(latestProcessedTweetId.toString());
      } else {
        console.log("No new tweets processed in this batch requiring update to last replied ID.");
      }
    } else {
      console.log('No new mention tweets found in this batch.');
    }
  } catch (error) {
    console.error('Error in main function:', error);
  }
}

// Improved Redis functions for better reliability
async function loadLastRepliedTweetId(): Promise<string | null> {
  try {
    return await redis.get(LAST_REPLIED_TWEET_KEY);
  } catch (error) {
    console.error("Error loading last replied tweet ID from Redis:", error);
    return null; // Return null on error rather than crashing
  }
}

async function saveLastRepliedTweetId(tweetId: string): Promise<void> {
  try {
    await redis.set(LAST_REPLIED_TWEET_KEY, tweetId);
    console.log(`Successfully saved tweet ID ${tweetId} to Redis`);
  } catch (error) {
    console.error("Error saving last replied tweet ID to Redis:", error);
    // Continue execution even if Redis write fails
  }
}

async function loginWithRetry(
  maxRetries: number = 3,
  delayBetweenRetries: number = 10000 // 10 seconds
): Promise<Scraper | null> {
  let retryCount = 0;
  
  while (retryCount < maxRetries) {
    try {
      console.log(`Twitter login attempt ${retryCount + 1}/${maxRetries}...`);
      const scraper = new Scraper();
      
      await scraper.login(
        process.env.MY_USERNAME || '',
        process.env.PASSWORD || '',
        process.env.EMAIL || ''
      );
      
      console.log('Twitter login successful!');
      return scraper;
    } catch (error) {
      retryCount++;
      console.error(`Twitter login failed (attempt ${retryCount}/${maxRetries}):`, error);
      
      if (retryCount >= maxRetries) {
        console.error(`All ${maxRetries} login attempts failed. Twitter functionality will be disabled.`);
        return null;
      }
      
      console.log(`Waiting ${delayBetweenRetries/1000} seconds before retrying...`);
      await new Promise(resolve => setTimeout(resolve, delayBetweenRetries));
    }
  }
  
  return null;
}

function validateEnvironmentVariables(): boolean {
  const requiredVars = [
    'MY_USERNAME',
    'PASSWORD',
    'EMAIL',
    'PRIVY_CLIENT_ID',
    'PRIVY_CLIENT_SECRET',
    'GROQ_API_KEY',
    'REDIS_HOST',
    'REDIS_PORT',
    'FRONTEND_URL'
  ];
  
  let allValid = true;
  const missing: string[] = [];
  
  requiredVars.forEach(varName => {
    if (!process.env[varName]) {
      missing.push(varName);
      allValid = false;
    }
  });
  
  if (!allValid) {
    console.error(`
=================================================
MISSING ENVIRONMENT VARIABLES
=================================================
The following required variables are missing:
${missing.map(v => `- ${v}`).join('\n')}

Please check your .env file and make sure all required
variables are set correctly.
=================================================
`);
  } else {
    console.log('✅ All required environment variables are set.');
  }
  
  return allValid;
}

// Twitter credentials validation function - test the login without trying to use it
async function validateTwitterCredentials(): Promise<boolean> {
  console.log('Testing Twitter credentials...');
  
  try {
    const scraper = new Scraper();
    
    await scraper.login(
      process.env.MY_USERNAME || '',
      process.env.PASSWORD || '',
      process.env.EMAIL || ''
    );
    
    console.log('✅ Twitter credentials are valid.');
    return true;
  } catch (error) {
    console.error('❌ Twitter credentials validation failed:');
    
    const errorString = String(error);
    
    // Try to provide more helpful error messages based on the error pattern
    if (errorString.includes('399')) {
      console.error(`
Twitter returned a 399 error, which typically means incorrect username or password.
Please double-check your MY_USERNAME, PASSWORD, and EMAIL environment variables.

Common issues:
1. Password may be incorrect or recently changed
2. Twitter may be requiring a CAPTCHA or additional verification
3. The account may be locked due to suspicious activity

You may need to log in manually on twitter.com first to clear any verification requirements.
`);
    } else if (errorString.includes('401')) {
      console.error(`
Twitter returned a 401 error, which indicates unauthorized access.
Please verify that your credentials are correct and that your account isn't restricted.
`);
    } else if (errorString.includes('rate limit')) {
      console.error(`
Twitter is rate limiting your requests. This may be because:
1. Too many login attempts in a short period
2. The IP address you're using is shared/blocked
3. Twitter's systems have flagged your activity as suspicious

Wait at least 15 minutes before retrying.
`);
    } else {
      console.error('Error details:', error);
    }
    
    return false;
  }
}

// Troubleshooting guide function
function printTwitterTroubleshootingGuide(): void {
  console.log(`
=================================================
TWITTER LOGIN TROUBLESHOOTING GUIDE
=================================================

1. Manual Check:
   - Login to Twitter manually first in your browser
   - Clear any CAPTCHA/verification challenges
   - Make sure the account is in good standing

2. Check Credentials:
   - Verify username has correct capitalization (though it should be case-insensitive)
   - Make sure password is correct (recently changed?)
   - Double-check email matches Twitter account email

3. Rate Limiting:
   - If you've been attempting to login repeatedly, Twitter may temporarily block login attempts
   - Try waiting 15-30 minutes before retrying
   - Consider using a different IP address if possible

4. Login Security:
   - If you use 2FA, make sure it's disabled or you're handling it correctly
   - Check if your account needs to approve new login locations

5. Alternative Approach:
   - Consider using Twitter's API with API keys instead
   - This requires a developer account but is more reliable

=================================================
`);
}

async function start(): Promise<void> {
    console.log('[Start Function] Entered.');
    
    // Add error handlers for uncaught exceptions and unhandled rejections
    process.on('uncaughtException', async (error) => {
        console.error('Uncaught Exception:', error);
        try {
            await reconnectWithRetry('database', connectToDatabase);
        } catch (reconnectError) {
            console.error('Fatal: Could not recover from uncaught exception:', reconnectError);
            process.exit(1);
        }
    });

    process.on('unhandledRejection', async (reason, promise) => {
        console.error('Unhandled Rejection at:', promise, 'reason:', reason);
        try {
            await reconnectWithRetry('database', connectToDatabase);
        } catch (reconnectError) {
            console.error('Fatal: Could not recover from unhandled rejection:', reconnectError);
            process.exit(1);
        }
    });

    const envValid = validateEnvironmentVariables();
    if (!envValid) {
        console.warn('Missing required environment variables - attempting to continue with available configuration...');
        // Continue execution but with warning
    }
    
    // Validate Twitter credentials specifically
    const twitterValid = await validateTwitterCredentials();
    if (!twitterValid) {
        printTwitterTroubleshootingGuide();
        console.warn('Twitter authentication failed - continuing with limited functionality...');
        // Continue with server only, no Twitter bot
    }
    
    // --- Restore Complex Initializations ---
    try {
        console.log('[Start Function] Connecting to database...');
        await connectToDatabase(); // Connect to DB here
        console.log('[Start Function] Database connection successful (or connection attempt initiated).');
    } catch (dbError) {
        console.error('[Start Function] FATAL: Database connection failed on startup:', dbError);
        process.exit(1); // Exit if DB connection fails critically on start
    }

    const scraper = new Scraper();
    try {
        console.log(`Attempting to log in to Twitter as ${process.env.MY_USERNAME}...`);
        await scraper.login(
            process.env.MY_USERNAME || '',
            process.env.PASSWORD || '',
            process.env.EMAIL || ''
        );
        console.log('Twitter login successful!');
    } catch (error) {
        console.error('Fatal Error: Twitter login failed:', error);
        process.exit(1);
    }

    const privyClient = new PrivyClient(
        process.env.PRIVY_CLIENT_ID || '',
        process.env.PRIVY_CLIENT_SECRET || ''
    );
    console.log('Privy client initialized.');

    const llm = new ChatGroq({
        apiKey: process.env.GROQ_API_KEY || '',
        model: "llama3-8b-8192"
    });
    console.log('LLM initialized.');

    cron.schedule('*/60 * * * * *', async () => {
        console.log('Cron job triggered: Running Twitter bot logic...');
        await main(scraper, privyClient, llm);
        console.log('Cron job finished. Waiting for next run...');
        console.log("_______________________________________________________________________________________________________________ \n");
    });
    console.log('Twitter bot cron job scheduled.');
    // --- End of Restored Section ---

    console.log(`[Start Function] Effective PORT from environment: ${process.env.PORT}`);
    console.log(`[Start Function] Port variable set to: ${port}`);
    console.log('[Start Function] Attempting to start server listener...'); // Log before listen attempt
    
    const server = app.listen(port, () => {
        // This block only runs if listen() is successful
        console.log('<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<');
        console.log(`>>> SERVER LISTENING SUCCESSFULLY ON PORT ${port} <<<`);
        console.log('<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<');
        console.log(`Withdrawal endpoint available at POST http://localhost:${port}/api/withdraw`);
        console.log(`Health check available at GET http://localhost:${port}/health`);
    });

    // Add error handling specifically for the server instance
    server.on('error', (error) => {
        console.error(`
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
SERVER LISTENER ERROR on port ${port}
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
        console.error(error);
        process.exit(1); // Exit if the server fails to start listening
    });

    console.log('[Start Function] Listener setup initiated (waiting for success/error).'); // Log after initiating listen

    // Add memory check interval
    setInterval(checkMemoryUsage, 60000); // Check every minute
}

app.use((err: Error, req: express.Request, res: express.Response, next: NextFunction) => {
    console.error("[Global Error Handler] Caught an error:", err);
    // Log stack trace for more details
    if (err.stack) {
      console.error(err.stack);
    }
    res.status(500).json({ 
      message: 'Something broke on the server!',
      error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    });
});

console.log('[Server Setup] Starting the application...'); // Log before calling start()
start().catch(error => {
    console.error("Fatal error during startup:", error);
    process.exit(1);
}); 