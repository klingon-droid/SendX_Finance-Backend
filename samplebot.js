import Redis from 'ioredis';
import { Scraper, SearchMode } from 'agent-twitter-client';
import cron from 'node-cron';
// import { onchainAction } from './index.js';
import { PrivyClient } from '@privy-io/server-auth';
import dotenv from 'dotenv';

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

async function main(scraper, privyClient) {
    try {
        const getTweets = await scraper.fetchSearchTweets(
            `@${process.env.MY_USERNAME}`,
            20,
            SearchMode.Latest
        );
        console.log('Fetched tweets:', getTweets);

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
                    console.log('New tweet found:', tweet);

                    // Call your function to reply to the tweet
                    try {
                        await replyToTweet(scraper, tweet, privyClient);
                        console.log('Replied to tweet ID:', tweet.id);
                    } catch (replyError) {
                        console.error('Error replying to tweet ID:', tweet.id, replyError);
                    }
                } else {
                    console.log('Tweet ID already replied to:', tweet.id);
                    break;
                }
            }

            // Update the last replied tweet ID to the latest tweet's ID
            await saveLastRepliedTweetId(formattedTweets[0].id);
            console.log('Updated last replied tweet ID to:', formattedTweets[0].id);
        } else {
            console.log('No tweets found.');
        }
    } catch (error) {
        console.error('Error in main function:', error);
    }
}

async function replyToTweet(scraper, tweet, privyClient) {
    try {
        const username = 'crypt0_tracker'; // @TODO: make this dynamic

        const user = await privyClient.getUserByTwitterUsername(username);
        console.log('User already exists:', user);
        if (!user) {
            console.log('User not found:', username);
            const userDetails = await scraper.getProfile(username)
            console.log('User details:', userDetails);
            const user = await privyClient.importUser({
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
            console.log('User imported via twitter username:', user);
        }

        // const response = await onchainAction(tweet.text); @TODO: Uncomment when done testing

        console.log(`Replying to tweet ID: ${tweet.id}`);
        await scraper.sendTweet('Hello', tweet.id);
        console.log('Replied to tweet ID:', tweet.id);
        // Example: await scraper.replyToTweet(tweet.id, 'Your reply message here');
    } catch (error) {
        console.error('Error in replyToTweet function:', error);
        throw error; // Re-throw the error to be caught in the main function
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

    // Schedule the main function to run every 20 seconds
    cron.schedule('*/20 * * * * *', async () => {
        console.log('Running the scheduled task...');
        await main(scraper, client);
    });
}

start();
