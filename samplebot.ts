import Redis from 'ioredis';
import { Scraper, SearchMode } from 'agent-twitter-client';
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
import { getUserBalance, updateUserBalance } from './pages/api/userBalanceRoutes';
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, clusterApiUrl, Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';


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
console.log('[Server Setup] Express app initialized.'); // Log after app creation

const port = process.env.PORT || 3005;

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));

// Add a log *before* body parsing to see if requests hit the server at all
app.use((req, res, next) => {
  if (req.path === '/api/withdraw') {
    console.log(`[Middleware Logger] Received request: ${req.method} ${req.path}`);
  }
  next();
});

app.use(express.json());

// Explicitly handle OPTIONS requests for the withdraw endpoint BEFORE the POST handler
app.options('/api/withdraw', cors()); // Enable CORS preflight for this route

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

async function loadLastRepliedTweetId(): Promise<string | null> {
    return await redis.get(LAST_REPLIED_TWEET_KEY);
}

async function saveLastRepliedTweetId(tweetId: string): Promise<void> {
    await redis.set(LAST_REPLIED_TWEET_KEY, tweetId);
}

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

app.get('/health', (req: express.Request, res: express.Response) => {
    res.json({ status: 'ok' });
});

async function replyToTweet(
    scraper: Scraper,
    tweet: Tweet,
    privyClient: PrivyClient,
    llm: ChatGroq | Ollama
): Promise<void> {
    try {
        const tweetText = tweet.text;
        const sender = tweet.username;

        const backendApiBaseUrl = process.env.BACKEND_API_URL || `http://localhost:${port}`;
        const senderinfo = await axios.get<UserBalance>(`${backendApiBaseUrl}/api/userBalance?username=${sender}`);
        
        if (senderinfo.data.data === null) {
            console.log("User not found");
            await scraper.sendTweet(`@${sender} Please register first.`, tweet.id);
            return;
        }
        
        const balance = senderinfo.data.data.balance;

        const result = await getUsername(tweetText, llm, scraper, tweet.id);
        if (!result) {
            console.log("Could not parse username and amount");
            return;
        }
        
        const { username: recipientUsername, amount } = result;
        console.log('Recipient Username:', recipientUsername);
        console.log('Amount:', amount);

        if (balance < amount) {
            console.log("Deposited funds are insufficient");
            await scraper.sendTweet(`@${sender} Deposited funds are insufficient`, tweet.id);
            return;
        }

        let user = await privyClient.getUserByTwitterUsername(recipientUsername);
        let isNewUser = false;
        if (!user) {
            console.log('Recipient user not found on Privy, attempting to import:', recipientUsername);
            const userDetails = await scraper.getProfile(recipientUsername) as UserProfile;
            if (!userDetails?.userId || !userDetails?.username) {
                console.log('Could not fetch recipient details from Twitter');
                await scraper.sendTweet(`@${sender} Could not fetch recipient details for @${recipientUsername}`, tweet.id);
                return;
            }
            console.log('Recipient Twitter details:', userDetails);
            try {
                user = await privyClient.importUser({
                    linkedAccounts: [
                        {
                            type: 'twitter_oauth',
                            subject: userDetails.userId,
                            name: userDetails.name || null,
                            username: userDetails.username || null,
                        },
                    ],
                    createSolanaWallet: true,
                    customMetadata: {
                        username: userDetails.username
                    },
                });
                isNewUser = true;
                console.log('Successfully imported recipient user to Privy:', recipientUsername);
            } catch (importError) {
                console.error('Error importing recipient user to Privy:', importError);
                await scraper.sendTweet(`@${sender} Error setting up recipient @${recipientUsername}`, tweet.id);
                return;
            }
        }

        if (!user?.wallet?.address) {
            console.log('Recipient user wallet not found (Privy):', recipientUsername);
            await scraper.sendTweet(`@${sender} Could not find or create recipient wallet for @${recipientUsername}`, tweet.id);
            return;
        }

        console.log(`Recipient wallet address: ${user.wallet.address}`);
        if (isNewUser) {
            console.log("Waiting for 10 seconds for wallet creation propagation...");
            await new Promise(resolve => setTimeout(resolve, 10000));
            console.log("10 seconds passed");
        } else {
            console.log("Waiting for 5 seconds before sending funds...");
            await new Promise(resolve => setTimeout(resolve, 5000));
            console.log("5 seconds passed");
        }

        const signature = await onchainAction(user.wallet.address, amount);
        console.log(`Transaction signature: ${signature}`);
        
        await axios.post(`${backendApiBaseUrl}/api/userBalance`, {
            username: sender,
            balance: balance - amount,
        });
        console.log(`Updated balance for sender: ${sender}`);

        const solscanUrl = `https://solscan.io/tx/${signature}`;
        console.log(`Replying to tweet ID: ${tweet.id} with Solscan link: ${solscanUrl}`);
        await scraper.sendTweet(`@${sender} Sent ${amount} SOL to @${recipientUsername}. Tx: ${solscanUrl}`, tweet.id);
        console.log('Replied to tweet ID:', tweet.id);

    } catch (error) {
        console.error('Error in replyToTweet function for tweet ID:', tweet.id, error);
        try {
             await scraper.sendTweet(`@${tweet.username} Sorry, an error occurred processing your request.`, tweet.id);
        } catch (sendError) {
             console.error('Failed to send error message tweet:', sendError);
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
        console.log(`seen ${getTweets.tweets.length} tweets.`);


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
            // timeParsed: new Date(tweet.created_at).toISOString(),
            timeParsed: tweet.created_at ? new Date(tweet.created_at).toISOString() : new Date().toISOString(),
            timestamp: new Date(tweet.created_at).getTime() / 1000,
            html: tweet.html || ''
        }));

        if (formattedTweets.length > 0) {
            const lastRepliedTweetId = await loadLastRepliedTweetId();
            console.log('Last replied tweet ID from Redis:', lastRepliedTweetId);

            const lastRepliedTweetIdNum = lastRepliedTweetId ? BigInt(lastRepliedTweetId) : BigInt(0);
            let latestProcessedTweetId = lastRepliedTweetIdNum;

            formattedTweets.sort((a, b) => a.timestamp - b.timestamp);

            for (const tweet of formattedTweets) {
                const tweetIdNum = BigInt(tweet.id);
                console.log(`Processing tweet ID: ${tweet.id} (Num: ${tweetIdNum})`);

                if (tweetIdNum > lastRepliedTweetIdNum) {
                    if (tweet.text.includes(`@${myUsername}`)) {
                        console.log(`Tweet ${tweet.id} is a direct mention. Replying...`);
                        try {
                            await replyToTweet(scraper, tweet, privyClient, llm);
                            console.log('Successfully processed and replied to tweet ID:', tweet.id);
                            if (tweetIdNum > latestProcessedTweetId) {
                                latestProcessedTweetId = tweetIdNum;
                            }
                        } catch (replyError) {
                            console.error('Error replying to tweet ID:', tweet.id, replyError);
                        }
                    } else {
                        console.log(`Tweet ${tweet.id} does not directly mention @${myUsername} in text, skipping reply.`);
                        if (tweetIdNum > latestProcessedTweetId) {
                            latestProcessedTweetId = tweetIdNum;
                        }
                    }
                } else {
                    console.log(`Tweet ID ${tweet.id} is older than or same as last replied (${lastRepliedTweetId}), skipping.`);
                }
            }
            
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

async function start(): Promise<void> {
    console.log('[Start Function] Entered.'); // Log start function entry
    
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
}
// app.get('/api/userBalance', getUserBalance);
// app.post('/api/userBalance', updateUserBalance);

// Ensure the global error handler is defined AFTER all routes and middleware
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