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

dotenv.config();

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

async function replyToTweet(
    scraper: Scraper,
    tweet: Tweet,
    privyClient: PrivyClient,
    llm: ChatGroq | Ollama
): Promise<void> {
    try {
        const tweetText = tweet.text;
        const sender = tweet.username;

        const senderinfo = await axios.get<UserBalance>(`https://send-x-frontend.vercel.app/api/userBalance?username=${sender}`);
        if (senderinfo.data.data === null) {
            console.log("User not found");
            await scraper.sendTweet(`@${sender} Please register on https://send-x-frontend.vercel.app `, tweet.id);
            return;
        }
        const balance = senderinfo.data.data.balance;

        const result = await getUsername(tweetText, llm, scraper, tweet.id);
        if (!result) {
            console.log("Could not parse username and amount");
            return;
        }
        
        const { username, amount } = result;
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
            const userDetails = await scraper.getProfile(username) as UserProfile;
            if (!userDetails?.userId || !userDetails?.username) {
                console.log('Could not fetch user details');
                await scraper.sendTweet(`@${sender} Could not fetch recipient details`, tweet.id);
                return;
            }
            console.log('User details:', userDetails);
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
        }

        if (!user?.wallet?.address) {
            console.log('User wallet not found');
            await scraper.sendTweet(`@${sender} Could not find or create recipient wallet`, tweet.id);
            return;
        }

        console.log("Waiting for 5 seconds");
        await new Promise(resolve => setTimeout(resolve, 5000));
        console.log("5 seconds passed");

        const response = await onchainAction(user.wallet.address, amount);
        await axios.post("https://send-x-frontend.vercel.app/api/userBalance", {
            username: sender,
            balance: balance - amount,
        });

        console.log(`Replying to tweet ID: ${tweet.id}`);
        console.log('Response:', response);
        await scraper.sendTweet(`https://solscan.io/tx/${response}`, tweet.id);
        console.log('Replied to tweet ID:', tweet.id);
    } catch (error) {
        console.error('Error in replyToTweet function:', error);
        await scraper.sendTweet(`@${tweet.username} Error processing the transaction`, tweet.id);
        throw error;
    }
}

async function main(scraper: Scraper, privyClient: PrivyClient, llm: ChatGroq | Ollama): Promise<void> {
    try {
        const getTweets = await scraper.fetchSearchTweets(
            `@${process.env.MY_USERNAME}`,
            20,
            SearchMode.Latest
        );

        const formattedTweets = getTweets.tweets.map((tweet: any): Tweet => ({
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
            await saveLastRepliedTweetId(formattedTweets[0].id);
            console.log('Updated last replied tweet ID to:', formattedTweets[0].id);
        } else {
            console.log('No tweets found.');
        }
    } catch (error) {
        console.error('Error in main function:', error);
    }
}

async function start(): Promise<void> {
    const scraper = new Scraper();
    const client = new PrivyClient(
        process.env.PRIVY_CLIENT_ID || '',
        process.env.PRIVY_CLIENT_SECRET || ''
    );

    console.log(process.env.MY_USERNAME, process.env.PASSWORD, process.env.EMAIL);
    try {
        await scraper.login(
            process.env.MY_USERNAME || '',
            process.env.PASSWORD || '',
            process.env.EMAIL || ''
        );
        console.log('Logged in successfully!');
    } catch (error) {
        console.error('Error logging in:', error);
        return;
    }

    const llm = new ChatGroq({
        apiKey: process.env.GROQ_API_KEY || '',
        model: "llama3-8b-8192"
    });

    cron.schedule('*/60 * * * * *', async () => {
        console.log('Running the scheduled task...');
        await main(scraper, client, llm);
        console.log("_______________________________________________________________________________________________________________ \n");
    });
}

start(); 