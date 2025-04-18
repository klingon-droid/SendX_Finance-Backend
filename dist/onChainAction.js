"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.onchainAction = onchainAction;
const tweetnacl_1 = __importDefault(require("tweetnacl"));
const web3_js_1 = require("@solana/web3.js");
const bs58_1 = __importDefault(require("bs58"));
const web3_js_2 = require("@solana/web3.js");
const web3_js_3 = require("@solana/web3.js");
require("dotenv").config();
const SOLANA_PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY;
const fundingWallet = web3_js_1.Keypair.fromSecretKey(bs58_1.default.decode(SOLANA_PRIVATE_KEY));
const connection = new web3_js_1.Connection((0, web3_js_1.clusterApiUrl)("mainnet-beta"), "confirmed");
class SolanaWalletClientImpl {
    constructor(wallet, connection) {
        this.wallet = wallet;
        this.connection = connection;
    }
    getAddress() {
        return this.wallet.publicKey.toBase58();
    }
    getChain() {
        return { type: "solana" };
    }
    async signMessage(message) {
        const messageBytes = Buffer.from(message);
        const signature = tweetnacl_1.default.sign.detached(messageBytes, this.wallet.secretKey);
        return {
            signature: Buffer.from(signature).toString("base64"),
        };
    }
    async balanceOf(address) {
        const balance = await this.connection.getBalance(new web3_js_1.PublicKey(address));
        return {
            decimals: 9,
            symbol: "SOL",
            name: "Solana",
            value: BigInt(balance),
        };
    }
    async sendTransaction(transaction) {
        const tx = new web3_js_1.Transaction().add(...transaction.instructions);
        const signature = await (0, web3_js_1.sendAndConfirmTransaction)(this.connection, tx, [
            this.wallet,
        ]);
        return { hash: signature };
    }
    async read(request) {
        const accountInfo = await this.connection.getAccountInfo(new web3_js_1.PublicKey(request.accountAddress));
        return { value: accountInfo?.data || null };
    }
}
const solanaClient = new SolanaWalletClientImpl(fundingWallet, connection);
async function onchainAction(address, amount) {
    try {
        console.log(`🔄 Funding Wallet Public Key: ${fundingWallet.publicKey.toBase58()}`);
        const recipientPublicKey = new web3_js_1.PublicKey(address);
        console.log(`🔄 Recipient Public Key: ${recipientPublicKey.toBase58()}`);
        const transferAmount = amount * web3_js_2.LAMPORTS_PER_SOL;
        const tx = new web3_js_1.Transaction().add(web3_js_3.SystemProgram.transfer({
            fromPubkey: fundingWallet.publicKey,
            toPubkey: recipientPublicKey,
            lamports: transferAmount,
        }));
        const signature = await (0, web3_js_1.sendAndConfirmTransaction)(connection, tx, [
            fundingWallet,
        ]);
        console.log("Transaction sent and confirmed");
        return signature;
    }
    catch (error) {
        console.error("Error in onchainAction:", error);
        throw error;
    }
}
