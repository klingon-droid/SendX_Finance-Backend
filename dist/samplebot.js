"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ioredis_1 = __importDefault(require("ioredis"));
const agent_twitter_client_1 = require("agent-twitter-client");
const node_cron_1 = __importDefault(require("node-cron"));
const username_1 = require("./username");
const server_auth_1 = require("@privy-io/server-auth");
const dotenv_1 = __importDefault(require("dotenv"));
const groq_1 = require("@langchain/groq");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const mongodb_1 = require("./mongodb");
const uuid_1 = require("uuid");
const web3_js_1 = require("@solana/web3.js");
dotenv_1.default.config();
process.on('uncaughtException', (err, origin) => {
    console.error(`
========================================
PROCESS ENCOUNTERED UNCAUGHT EXCEPTION
========================================
Error:`, err);
    console.error('Origin:', origin);
    console.error('Exiting process...');
    process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error(`
=============================================
PROCESS ENCOUNTERED UNHANDLED REJECTION
=============================================
Reason:`, reason);
    console.error('At promise:', promise);
});
dotenv_1.default.config();
const app = (0, express_1.default)();
console.log('[Server Setup] Express app initialized.');
const port = process.env.PORT || 3005;
app.use((0, cors_1.default)({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true
}));
app.use((req, res, next) => {
    if (req.path === '/api/withdraw') {
        console.log(`[Middleware Logger] Received request: ${req.method} ${req.path}`);
    }
    next();
});
app.use(express_1.default.json());
app.options('/api/withdraw', (0, cors_1.default)());
const redis = new ioredis_1.default({
    host: process.env.REDIS_HOST || '',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    username: process.env.REDIS_USERNAME || '',
    password: process.env.REDIS_PASSWORD || '',
    tls: {
        rejectUnauthorized: false
    }
});
const LAST_REPLIED_TWEET_KEY = 'lastRepliedTweetId';
async function withdrawHandler(req, res) {
    console.log('[withdrawHandler] Entered function.');
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
        console.log('[withdrawHandler] Connecting to database...');
        const { db } = await (0, mongodb_1.connectToDatabase)();
        const usersCollection = db.collection('users');
        console.log('[withdrawHandler] Database connected.');
        console.log(`[withdrawHandler] Finding user: ${username}`);
        const user = await usersCollection.findOne({ username });
        if (!user) {
            console.log('[withdrawHandler] User not found.');
            console.log('[withdrawHandler] Sending 404 response (User not found)...');
            return res.status(404).json({
                message: 'User not found',
                error: 'User does not exist in the database'
            });
        }
        console.log(`[withdrawHandler] User found in DB. Balance: ${user.balance}`);
        if (user.balance < amount) {
            console.log('[withdrawHandler] Insufficient balance.');
            console.log('[withdrawHandler] Sending 400 response (Insufficient balance)...');
            return res.status(400).json({
                message: 'Insufficient balance',
                error: 'User does not have enough deposited SOL to withdraw'
            });
        }
        console.log('[withdrawHandler] User has sufficient balance.');
        console.log('[withdrawHandler] Initializing Privy client...');
        const privyClient = new server_auth_1.PrivyClient(process.env.PRIVY_CLIENT_ID, process.env.PRIVY_CLIENT_SECRET);
        console.log('[withdrawHandler] Privy client initialized.');
        console.log(`[withdrawHandler] Getting Privy user by Twitter username: ${username}`);
        const privyUser = await privyClient.getUserByTwitterUsername(username);
        if (!privyUser?.wallet?.address) {
            console.log('[withdrawHandler] Privy user or wallet not found.');
            console.log('[withdrawHandler] Sending 404 response (Wallet not found)...');
            return res.status(404).json({
                message: 'Wallet not found',
                error: 'User does not have a wallet associated with their Privy account'
            });
        }
        console.log(`[withdrawHandler] Privy user found. Wallet Address: ${privyUser.wallet.address}`);
        if (privyUser.wallet.address !== walletAddress) {
            console.log('[withdrawHandler] Provided wallet address does not match Privy wallet.');
            console.log('[withdrawHandler] Sending 400 response (Invalid wallet address)...');
            return res.status(400).json({
                message: 'Invalid wallet address',
                error: 'Provided wallet address does not match user\\\'s Privy wallet'
            });
        }
        console.log('[withdrawHandler] Provided wallet address matches Privy wallet.');
        console.log('[withdrawHandler] Connecting to Solana devnet...');
        const connection = new web3_js_1.Connection((0, web3_js_1.clusterApiUrl)("devnet"), "confirmed");
        console.log('[withdrawHandler] Solana connection established.');
        try {
            console.log(`[withdrawHandler inner try] Checking balance for wallet: ${walletAddress}`);
            const walletBalance = await connection.getBalance(new web3_js_1.PublicKey(walletAddress));
            const walletBalanceInSol = walletBalance / web3_js_1.LAMPORTS_PER_SOL;
            console.log(`[withdrawHandler inner try] Wallet balance: ${walletBalanceInSol} SOL`);
            const MINIMUM_FEE_BALANCE = 0.00001;
            if (walletBalanceInSol < MINIMUM_FEE_BALANCE) {
                console.log('[withdrawHandler inner try] Insufficient wallet balance for fees.');
                console.log('[withdrawHandler inner try] Sending 400 response (Insufficient wallet balance)...');
                return res.status(400).json({
                    message: 'Insufficient wallet balance',
                    error: 'Your wallet needs at least 0.00001 SOL to cover transaction fees'
                });
            }
            console.log('[withdrawHandler inner try] Creating Solana transaction...');
            const transaction = new web3_js_1.Transaction().add(web3_js_1.SystemProgram.transfer({
                fromPubkey: new web3_js_1.PublicKey(walletAddress),
                toPubkey: new web3_js_1.PublicKey(recipientAddress),
                lamports: amount * web3_js_1.LAMPORTS_PER_SOL,
            }));
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = new web3_js_1.PublicKey(walletAddress);
            const fee = await connection.getFeeForMessage(transaction.compileMessage());
            const feeInSol = typeof fee === 'number' ? fee / web3_js_1.LAMPORTS_PER_SOL : 0;
            console.log(`[withdrawHandler inner try] Transaction fee details:`, {
                feeInLamports: fee,
                feeInSol,
                blockhash,
                lastValidBlockHeight,
                feePayer: walletAddress
            });
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
        }
        catch (error) {
            console.error('Error processing withdrawal:', error);
            console.log('[withdrawHandler inner catch] Sending 500 response...');
            return res.status(500).json({
                message: 'Failed to process withdrawal',
                error: error instanceof Error ? error.message : 'Unknown error occurred during withdrawal'
            });
        }
    }
    catch (error) {
        console.error('Error in withdrawHandler (outer catch):', error);
        console.log('[withdrawHandler outer catch] Sending 500 response...');
        return res.status(500).json({
            message: 'Internal server error',
            error: error instanceof Error ? error.message : 'An unexpected error occurred'
        });
    }
}
app.post('/api/withdraw', async (req, res) => {
    console.log('[POST /api/withdraw] Route handler entered.');
    try {
        console.log('[POST /api/withdraw] Calling withdrawHandler...');
        await withdrawHandler(req, res);
        console.log('[POST /api/withdraw] withdrawHandler finished.');
    }
    catch (error) {
        console.error('Error in withdraw handler route catch block:', error);
        console.log('[POST /api/withdraw catch] Sending 500 response...');
        res.status(500).json({
            message: 'Internal server error in route',
            error: error instanceof Error ? error.message : 'An unexpected error occurred in route'
        });
    }
});
app.get('/api/userBalance', async (req, res) => {
    try {
        const { username } = req.query;
        if (!username) {
            return res.status(400).json({
                message: 'Missing username',
                error: 'Username parameter is required'
            });
        }
        const { db } = await (0, mongodb_1.connectToDatabase)();
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
    }
    catch (error) {
        console.error('Error fetching user balance:', error);
        return res.status(500).json({
            message: 'Internal server error',
            error: error instanceof Error ? error.message : 'An unexpected error occurred'
        });
    }
});
app.post('/api/userBalance', async (req, res) => {
    try {
        const { username, balance } = req.body;
        if (!username || balance === undefined) {
            return res.status(400).json({
                message: 'Missing required fields',
                error: 'Username and balance are required'
            });
        }
        const { db } = await (0, mongodb_1.connectToDatabase)();
        const usersCollection = db.collection('users');
        const result = await usersCollection.updateOne({ username }, { $set: { balance } }, { upsert: true });
        return res.status(200).json({
            message: result.upsertedCount ? 'User created with balance' : 'User balance updated',
            data: { username, balance }
        });
    }
    catch (error) {
        console.error('Error updating user balance:', error);
        return res.status(500).json({
            message: 'Internal server error',
            error: error instanceof Error ? error.message : 'An unexpected error occurred'
        });
    }
});
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});
async function replyToTweet(scraper, tweet, privyClient, llm) {
    try {
        console.log(tweet);
        const tweetText = tweet.text;
        const sender = tweet.username;
        const myUsername = process.env.MY_USERNAME;
        if (sender.toLowerCase() === myUsername?.toLowerCase()) {
            console.log(`Skipping tweet ${tweet.id} because it's from our own bot`);
            return;
        }
        if (tweet.isRetweet || tweet.isQuoted) {
            console.log(`Skipping tweet ${tweet.id} because it's a retweet or quote`);
            return;
        }
        const result = await (0, username_1.getUsername)(tweetText, llm, scraper, tweet.id);
        if (!result) {
            console.log("Could not parse username and amount");
            await scraper.sendTweet(`@${sender} Please format your request as "@${myUsername} send 0.1 to @recipient"`, tweet.id);
            return;
        }
        const { username: recipientUsername, amount } = result;
        console.log('Recipient Username:', recipientUsername);
        console.log('Amount:', amount);
        if (recipientUsername.toLowerCase() === myUsername?.toLowerCase()) {
            console.log(`Skipping tweet ${tweet.id} because recipient is our own bot`);
            await scraper.sendTweet(`@${sender} I cannot send SOL to myself. Please specify a different recipient.`, tweet.id);
            return;
        }
        let recipientUser = await privyClient.getUserByTwitterUsername(recipientUsername);
        let isNewUser = false;
        if (!recipientUser) {
            console.log('Recipient user not found on Privy, attempting to import:', recipientUsername);
            const userDetails = await scraper.getProfile(recipientUsername);
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
            }
            catch (importError) {
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
        const transactionId = (0, uuid_1.v4)();
        const { db } = await (0, mongodb_1.connectToDatabase)();
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
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
        });
        const approvalUrl = `${process.env.FRONTEND_URL}/approve/${transactionId}`;
        await scraper.sendTweet(`@${sender} Ready to send ${amount} SOL to @${recipientUsername}. ` +
            `Click here to approve this transaction: ${approvalUrl} ` +
            `(Link expires in 24 hours)`, tweet.id);
        console.log(`Created transaction intent ${transactionId} for ${sender} to send ${amount} SOL to ${recipientUsername}`);
    }
    catch (error) {
        console.error('Error in replyToTweet function for tweet ID:', tweet.id, error);
        try {
            await scraper.sendTweet(`@${tweet.username} Sorry, an error occurred processing your request.`, tweet.id);
        }
        catch (sendError) {
            console.error('Failed to send error message tweet:', sendError);
        }
    }
}
app.get('/api/transactions/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!id) {
            res.status(400).json({ success: false, error: 'Transaction ID is required' });
            return;
        }
        const { db } = await (0, mongodb_1.connectToDatabase)();
        const transactionsCollection = db.collection('transactions');
        const transaction = await transactionsCollection.findOne({ id });
        if (!transaction) {
            res.status(404).json({ success: false, error: 'Transaction not found' });
            return;
        }
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
    }
    catch (error) {
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
        const { db } = await (0, mongodb_1.connectToDatabase)();
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
        if (transaction.expiresAt && new Date() > new Date(transaction.expiresAt)) {
            res.status(410).json({ success: false, error: 'Transaction has expired' });
            return;
        }
        await transactionsCollection.updateOne({ id }, {
            $set: {
                status: 'completed',
                signature,
                senderAddress,
                completedAt: new Date()
            }
        });
        try {
            const scraper = new agent_twitter_client_1.Scraper();
            await scraper.login(process.env.MY_USERNAME || '', process.env.PASSWORD || '', process.env.EMAIL || '');
            const solscanUrl = `https://solscan.io/tx/${signature}`;
            const claimUrl = `${process.env.FRONTEND_URL}`;
            await scraper.sendTweet(`@${transaction.sender} You've successfully sent ${transaction.amount} SOL to @${transaction.recipient}. ` +
                `Tx: ${solscanUrl} \n\n` +
                `@${transaction.recipient} You've received ${transaction.amount} SOL! Visit ${claimUrl} to claim your SOL.`, transaction.tweetId);
        }
        catch (twitterError) {
            console.error('Error sending confirmation tweet:', twitterError);
        }
        res.status(200).json({
            success: true,
            message: 'Transaction completed successfully',
            data: {
                signature,
                solscanUrl: `https://solscan.io/tx/${signature}`
            }
        });
    }
    catch (error) {
        console.error('Error completing transaction:', error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'An unexpected error occurred'
        });
    }
});
async function main(scraper, privyClient, llm) {
    try {
        const myUsername = process.env.MY_USERNAME;
        if (!myUsername) {
            console.error("MY_USERNAME environment variable not set!");
            return;
        }
        console.log(`Fetching tweets mentioning @${myUsername}...`);
        const getTweets = await scraper.fetchSearchTweets(`@${myUsername}`, 20, agent_twitter_client_1.SearchMode.Latest);
        console.log(`Seen ${getTweets.tweets.length} tweets.`);
        const formattedTweets = getTweets.tweets.map((tweet) => ({
            id: tweet.id_str || tweet.id,
            conversationId: tweet.conversation_id_str || tweet.conversationId,
            mentions: tweet.entities?.user_mentions?.map((m) => m.screen_name) || tweet.mentions || [],
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
            formattedTweets.sort((a, b) => a.timestamp - b.timestamp);
            for (const tweet of formattedTweets) {
                const tweetIdNum = BigInt(tweet.id);
                if (tweetIdNum > latestProcessedTweetId) {
                    latestProcessedTweetId = tweetIdNum;
                }
            }
            const processedTweetIds = new Set();
            for (const tweet of formattedTweets) {
                const tweetIdNum = BigInt(tweet.id);
                console.log(`Processing tweet ID: ${tweet.id} (Num: ${tweetIdNum})`);
                if (processedTweetIds.has(tweet.id)) {
                    console.log(`Tweet ${tweet.id} was already processed in this batch, skipping.`);
                    continue;
                }
                if (tweet.username.toLowerCase() === myUsername.toLowerCase()) {
                    console.log(`Tweet ${tweet.id} is from our own bot, skipping.`);
                    processedTweetIds.add(tweet.id);
                    continue;
                }
                if (tweetIdNum > lastRepliedTweetIdNum) {
                    if (tweet.text.toLowerCase().includes(`@${myUsername.toLowerCase()}`) &&
                        !tweet.isRetweet &&
                        !tweet.isQuoted) {
                        console.log(`Tweet ${tweet.id} is a valid mention. Replying...`);
                        try {
                            await replyToTweet(scraper, tweet, privyClient, llm);
                            console.log('Successfully processed and replied to tweet ID:', tweet.id);
                            processedTweetIds.add(tweet.id);
                        }
                        catch (replyError) {
                            console.error('Error replying to tweet ID:', tweet.id, replyError);
                        }
                    }
                    else {
                        console.log(`Tweet ${tweet.id} does not qualify for a reply (retweet, quote, or not direct mention).`);
                        processedTweetIds.add(tweet.id);
                    }
                }
                else {
                    console.log(`Tweet ID ${tweet.id} is older than or same as last replied (${lastRepliedTweetId}), skipping.`);
                    processedTweetIds.add(tweet.id);
                }
            }
            if (latestProcessedTweetId > lastRepliedTweetIdNum) {
                console.log(`Updating last replied tweet ID in Redis to: ${latestProcessedTweetId.toString()}`);
                await saveLastRepliedTweetId(latestProcessedTweetId.toString());
            }
            else {
                console.log("No new tweets processed in this batch requiring update to last replied ID.");
            }
        }
        else {
            console.log('No new mention tweets found in this batch.');
        }
    }
    catch (error) {
        console.error('Error in main function:', error);
    }
}
async function loadLastRepliedTweetId() {
    try {
        return await redis.get(LAST_REPLIED_TWEET_KEY);
    }
    catch (error) {
        console.error("Error loading last replied tweet ID from Redis:", error);
        return null;
    }
}
async function saveLastRepliedTweetId(tweetId) {
    try {
        await redis.set(LAST_REPLIED_TWEET_KEY, tweetId);
        console.log(`Successfully saved tweet ID ${tweetId} to Redis`);
    }
    catch (error) {
        console.error("Error saving last replied tweet ID to Redis:", error);
    }
}
async function loginWithRetry(maxRetries = 3, delayBetweenRetries = 10000) {
    let retryCount = 0;
    while (retryCount < maxRetries) {
        try {
            console.log(`Twitter login attempt ${retryCount + 1}/${maxRetries}...`);
            const scraper = new agent_twitter_client_1.Scraper();
            await scraper.login(process.env.MY_USERNAME || '', process.env.PASSWORD || '', process.env.EMAIL || '');
            console.log('Twitter login successful!');
            return scraper;
        }
        catch (error) {
            retryCount++;
            console.error(`Twitter login failed (attempt ${retryCount}/${maxRetries}):`, error);
            if (retryCount >= maxRetries) {
                console.error(`All ${maxRetries} login attempts failed. Twitter functionality will be disabled.`);
                return null;
            }
            console.log(`Waiting ${delayBetweenRetries / 1000} seconds before retrying...`);
            await new Promise(resolve => setTimeout(resolve, delayBetweenRetries));
        }
    }
    return null;
}
function validateEnvironmentVariables() {
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
    const missing = [];
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
    }
    else {
        console.log('✅ All required environment variables are set.');
    }
    return allValid;
}
async function validateTwitterCredentials() {
    console.log('Testing Twitter credentials...');
    try {
        const scraper = new agent_twitter_client_1.Scraper();
        await scraper.login(process.env.MY_USERNAME || '', process.env.PASSWORD || '', process.env.EMAIL || '');
        console.log('✅ Twitter credentials are valid.');
        return true;
    }
    catch (error) {
        console.error('❌ Twitter credentials validation failed:');
        const errorString = String(error);
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
        }
        else if (errorString.includes('401')) {
            console.error(`
Twitter returned a 401 error, which indicates unauthorized access.
Please verify that your credentials are correct and that your account isn't restricted.
`);
        }
        else if (errorString.includes('rate limit')) {
            console.error(`
Twitter is rate limiting your requests. This may be because:
1. Too many login attempts in a short period
2. The IP address you're using is shared/blocked
3. Twitter's systems have flagged your activity as suspicious

Wait at least 15 minutes before retrying.
`);
        }
        else {
            console.error('Error details:', error);
        }
        return false;
    }
}
function printTwitterTroubleshootingGuide() {
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
async function start() {
    console.log('[Start Function] Entered.');
    const envValid = validateEnvironmentVariables();
    if (!envValid) {
        console.warn('Missing required environment variables - attempting to continue with available configuration...');
    }
    const twitterValid = await validateTwitterCredentials();
    if (!twitterValid) {
        printTwitterTroubleshootingGuide();
        console.warn('Twitter authentication failed - continuing with limited functionality...');
    }
    try {
        console.log('[Start Function] Connecting to database...');
        await (0, mongodb_1.connectToDatabase)();
        console.log('[Start Function] Database connection successful (or connection attempt initiated).');
    }
    catch (dbError) {
        console.error('[Start Function] FATAL: Database connection failed on startup:', dbError);
        process.exit(1);
    }
    const scraper = new agent_twitter_client_1.Scraper();
    try {
        console.log(`Attempting to log in to Twitter as ${process.env.MY_USERNAME}...`);
        await scraper.login(process.env.MY_USERNAME || '', process.env.PASSWORD || '', process.env.EMAIL || '');
        console.log('Twitter login successful!');
    }
    catch (error) {
        console.error('Fatal Error: Twitter login failed:', error);
        process.exit(1);
    }
    const privyClient = new server_auth_1.PrivyClient(process.env.PRIVY_CLIENT_ID || '', process.env.PRIVY_CLIENT_SECRET || '');
    console.log('Privy client initialized.');
    const llm = new groq_1.ChatGroq({
        apiKey: process.env.GROQ_API_KEY || '',
        model: "llama3-8b-8192"
    });
    console.log('LLM initialized.');
    node_cron_1.default.schedule('*/60 * * * * *', async () => {
        console.log('Cron job triggered: Running Twitter bot logic...');
        await main(scraper, privyClient, llm);
        console.log('Cron job finished. Waiting for next run...');
        console.log("_______________________________________________________________________________________________________________ \n");
    });
    console.log('Twitter bot cron job scheduled.');
    console.log(`[Start Function] Effective PORT from environment: ${process.env.PORT}`);
    console.log(`[Start Function] Port variable set to: ${port}`);
    console.log('[Start Function] Attempting to start server listener...');
    const server = app.listen(port, () => {
        console.log('<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<');
        console.log(`>>> SERVER LISTENING SUCCESSFULLY ON PORT ${port} <<<`);
        console.log('<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<');
        console.log(`Withdrawal endpoint available at POST http://localhost:${port}/api/withdraw`);
        console.log(`Health check available at GET http://localhost:${port}/health`);
    });
    server.on('error', (error) => {
        console.error(`
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
SERVER LISTENER ERROR on port ${port}
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
        console.error(error);
        process.exit(1);
    });
    console.log('[Start Function] Listener setup initiated (waiting for success/error).');
}
app.use((err, req, res, next) => {
    console.error("[Global Error Handler] Caught an error:", err);
    if (err.stack) {
        console.error(err.stack);
    }
    res.status(500).json({
        message: 'Something broke on the server!',
        error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    });
});
console.log('[Server Setup] Starting the application...');
start().catch(error => {
    console.error("Fatal error during startup:", error);
    process.exit(1);
});
