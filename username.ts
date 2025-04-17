export async function getUsername(
  tweet: string,
  llm: any,
  scraper: any,
  id: any
) {
  try {
    // Get the bot's username from environment variable
    const botUsername = process.env.MY_USERNAME || "AeroSol_Finance";
    console.log("Bot username:", botUsername);
    
    // Log the original tweet for debugging
    console.log("Original tweet:", tweet);
    
    // Try to match using regex patterns first
    // Pattern: send X to @user
    const sendToPattern = /send\s+([\d.]+)\s*(?:SOL)?\s+to\s+@(\w+)/i;
    // Pattern: send @user X
    const sendUserPattern = /send\s+@(\w+)\s+([\d.]+)\s*(?:SOL)?/i;
    
    let matchResult = tweet.match(sendToPattern);
    let username = "";
    let amount = "";
    
    if (matchResult && matchResult.length >= 3) {
      amount = matchResult[1];
      username = matchResult[2];
      console.log("Regex matched 'send X to @user' pattern:", { amount, username });
    } else {
      matchResult = tweet.match(sendUserPattern);
      if (matchResult && matchResult.length >= 3) {
        username = matchResult[1];
        amount = matchResult[2];
        console.log("Regex matched 'send @user X' pattern:", { username, amount });
      } else {
        // Fallback to LLM if regex doesn't match
        console.log("No regex match, falling back to LLM");
        
        // Remove the bot mention to avoid confusion
        const cleanTweet = tweet.replace(new RegExp(`@${botUsername}\\b`, 'gi'), "").trim();
        console.log("Cleaned tweet for LLM:", cleanTweet);
        
        const prompt = `
        Extract the recipient's username and amount to send from this tweet.
        
        The tweet is: "${cleanTweet}"
        
        The format should be something like "send X SOL to @username" or similar variations.
        
        IMPORTANT:
        1. The bot's username is "@${botUsername}". DO NOT extract this as the recipient.
        2. If there are multiple usernames, identify which one is meant to receive the SOL.
        3. Only include the numeric amount (convert "one" to 1, etc.)
        
        Return only valid JSON in this format:
        {
          "username": "recipient_username_without_@",
          "amount": numeric_amount
        }
        `;
        
        console.log("Prompt:", prompt);
        const response = await llm.invoke(prompt);
        console.log("LLM Response:", response.content);
        
        try {
          const data = JSON.parse(response.content);
          username = data.username || "";
          amount = data.amount?.toString() || "";
        } catch (parseError) {
          console.error("Error parsing LLM response:", parseError);
          
          // Try to extract JSON if it's embedded in text
          const jsonMatch = response.content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              const data = JSON.parse(jsonMatch[0]);
              username = data.username || "";
              amount = data.amount?.toString() || "";
            } catch (e) {
              console.error("Error parsing extracted JSON:", e);
              throw new Error("Failed to parse LLM response");
            }
          } else {
            throw new Error("LLM response doesn't contain valid JSON");
          }
        }
      }
    }
    
    // Clean up the extracted data
    username = username.replace(/^@/, "").trim();
    amount = amount.toLowerCase().replace(/sol/g, "").trim();
    
    // Validate the data
    if (!username || username === "" || username.toLowerCase() === botUsername.toLowerCase()) {
      console.error("Invalid username:", username);
      console.error("Username matches bot:", username.toLowerCase() === botUsername.toLowerCase());
      throw new Error("Invalid or bot username detected");
    }
    
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      console.error("Invalid amount:", amount);
      throw new Error("Invalid amount");
    }
    
    console.log("Final extracted data:", { username, amount: parseFloat(amount) });
    return { username, amount: parseFloat(amount) };
  } catch (error) {
    console.log("Error in getUsername:", error);
    try {
      await scraper.sendTweet(
        `@${tweet.split(" ")[0].replace("@", "")} Incorrect tweet format. Please format as "send X SOL to @username"`,
        id
      );
    } catch (tweetError) {
      console.error("Error sending format instruction tweet:", tweetError);
    }
    return null;
  }
}