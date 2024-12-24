export async function getUsername(
  tweet: string,
  llm: any,
  scraper: any,
  id: any
) {
  //remove the @crypt0_tracker part from the tweet
  try {
    const substr = tweet.replace("@crypt0_tracker", "");
    const prompt = `Extract the recepient's username and amount to send from this message: ${substr}. Give the output in JSON format: {username: <username>, amount: <amount>}. only give json, nothing else.`;
    console.log("Prompt:", prompt);
    const response = await llm.invoke(prompt);
    console.log("Response:", response.content);
    const data = await JSON.parse(response.content);
    const username = data.username.replace("@", "").trim();
    const amount = data.amount.toLowerCase().replace("sol", "").trim();
    console.log("Username:", username);
    console.log("Amount:", amount);
    return { username, amount };
  } catch (error) {
    console.log("Error:", error);
    await scraper.sendTweet(`Incorrect tweet format.`, id);
    return null;
  }
}
