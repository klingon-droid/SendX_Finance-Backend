const Redis = require('ioredis');
const { Scraper, SearchMode } = require('agent-twitter-client');
const cron = require('node-cron');
const { onchainAction } = require('./onChainAction.js');
const { getUsername } = require('./username.js');
const { PrivyClient } = require('@privy-io/server-auth');
const dotenv = require('dotenv');
const { Ollama } = require("@langchain/ollama");
const { ChatGroq } = require("@langchain/groq");
const { default: axios } = require('axios');

dotenv.config();

const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
});

const LAST_REPLIED_TWEET_KEY = 'lastRepliedTweetId';

async function loadLastRepliedTweetId() {
    return await redis.get(LAST_REPLIED_TWEET_KEY);
}

async function saveLastRepliedTweetId(tweetId) {
    await redis.set(LAST_REPLIED_TWEET_KEY, tweetId);
}

async function replyToTweet(scraper, tweet, privyClient, llm) {
    try {
        const tweetText = tweet.text;
        const sender = tweet.username;

        const senderinfo = await axios.get(`https://sendx-pi.vercel.app/api/userBalance?username=${sender}`);
        if (senderinfo.data.data == null) {
            console.log("User not found");
            await scraper.sendTweet(`@${sender} Please register on https://sendx-pi.vercel.app `, tweet.id);
        }
        const balance = senderinfo.data.data.balance;



        const { username, amount } = await getUsername(tweetText, llm, scraper, tweet.id);
        console.log('Username:', username);
        console.log('Amount:', amount);

        if (balance < amount) {
            console.log("Deposited funds are insufficient");
            await scraper.sendTweet(`@${sender} Deposited funds are insufficient`, tweet.id);
            return;
        }

        let user = await privyClient.getUserByTwitterUsername(username);
        console.log('User already exists');
        if (!user) {
            console.log('User not found:', username);
            const userDetails = await scraper.getProfile(username)
            console.log('User details:', userDetails);
            user = await privyClient.importUser({
                linkedAccounts: [
                    {
                        type: 'twitter_oauth',
                        subject: userDetails.userId,
                        name: userDetails.name,
                        username: userDetails.username,
                    },
                ],
                createSolanaWallet: true,
                customMetadata: {
                    username: userDetails.username
                },
            });
            console.log('User imported via twitter username:', user.wallet.address);
        }
        console.log("Waiting for 5 seconds");
        //make the program wait here for 5 seconds
        await new Promise(resolve => setTimeout(resolve, 5000));
        console.log("5 seconds passed");


        const prompt = `Send ${amount} SOL to ${user.wallet.address} , only return the transaction hash as output , nothing else.`;
        console.log("Prompt:", prompt);
        // const response = await onchainAction(prompt, llm); // @TODO: Uncomment when done testing
        const response = await onchainAction(user.wallet.address, amount);
        const updateDB = await axios.post("https://sendx-pi.vercel.app/api/userBalance", {
            username: sender,
            balance: balance - amount,
        })

        console.log(`Replying to tweet ID: ${tweet.id}`);
        console.log('Response:', response);
        await scraper.sendTweet(`https://solscan.io/tx/${response}?cluster=devnet`, tweet.id);
        console.log('Replied to tweet ID:', tweet.id);
        // Example: await scraper.replyToTweet(tweet.id, 'Your reply message here');
    } catch (error) {
        console.error('Error in replyToTweet function:', error);
        await sendTweet(`@${sender} Error processing the transaction`, tweet.id);
        throw error; // Re-throw the error to be caught in the main function
    }
}

async function main(scraper, privyClient, llm) {
    try {
        const getTweets = await scraper.fetchSearchTweets(
            `@${process.env.MY_USERNAME}`,
            20,
            SearchMode.Latest
        );
        // console.log('Fetched tweets:', getTweets);

        const formattedTweets = getTweets.tweets.map(tweet => ({
            id: tweet.id,
            conversationId: tweet.conversationId,
            mentions: tweet.mentions,
            name: tweet.name,
            permanentUrl: tweet.permanentUrl,
            text: tweet.text,
            userId: tweet.userId,
            username: tweet.username,
            isQuoted: tweet.isQuoted,
            isReply: tweet.isReply,
            isRetweet: tweet.isRetweet,
            isPin: tweet.isPin,
            timeParsed: tweet.timeParsed,
            timestamp: tweet.timestamp,
            html: tweet.html
        }));

        if (formattedTweets.length > 0) {
            const lastRepliedTweetId = await loadLastRepliedTweetId();
            console.log('Last replied tweet ID from DB:', lastRepliedTweetId);

            const lastRepliedTweetIdNum = lastRepliedTweetId ? Number(lastRepliedTweetId) : 0;

            for (const tweet of formattedTweets) {
                const tweetIdNum = Number(tweet.id);
                console.log('Processing tweet ID:', tweet.id);

                if (tweetIdNum > lastRepliedTweetIdNum) {
                    // console.log('New tweet found:', tweet);

                    // Call your function to reply to the tweet
                    try {
                        await replyToTweet(scraper, tweet, privyClient, llm);
                        console.log('Replied to tweet ID:', tweet.id);
                    } catch (replyError) {
                        console.error('Error replying to tweet ID:', tweet.id, replyError);
                    }
                } else {
                    console.log('Tweet ID already replied to:', tweet.id);
                    break;
                }
            }
            console.log("for loop ended , going to save the last replied tweet id");
            await saveLastRepliedTweetId(formattedTweets[ 0 ].id);
            console.log('Updated last replied tweet ID to:', formattedTweets[ 0 ].id);
        } else {
            console.log('No tweets found.');
        }
    } catch (error) {
        console.error('Error in main function:', error);
    }
}



async function start() {
    const scraper = new Scraper();
    const client = new PrivyClient(
        process.env.PRIVY_CLIENT_ID,
        process.env.PRIVY_CLIENT_SECRET
    );
    // v1 login
    console.log(process.env.MY_USERNAME, process.env.PASSWORD, process.env.EMAIL);
    try {
        await scraper.login(
            process.env.MY_USERNAME,
            process.env.PASSWORD,
            process.env.EMAIL
        );
        console.log('Logged in successfully!');
    } catch (error) {
        console.error('Error logging in:', error);
        return;
    }
    // const llm = new Ollama({
    //     model: "llama3.2", // Default value
    //     baseUrl: "http://127.0.0.1:11434", // Default value
    // });

    const llm = new ChatGroq({
        model: "llama3-8b-8192",
    });

    // Schedule the main function to run every 20 seconds
    cron.schedule('*/60 * * * * *', async () => {
        console.log('Running the scheduled task...');
        await main(scraper, client, llm);
        console.log("_______________________________________________________________________________________________________________ \n");
    });
}

start();
