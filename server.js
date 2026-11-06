const express = require('express');
const cors = require('cors');
const { 
  Connection, 
  Keypair, 
  PublicKey, 
  Transaction, 
  SystemProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL
} = require('@solana/web3.js');
const { 
  getOrCreateAssociatedTokenAccount, 
  createTransferInstruction 
} = require('@solana/spl-token');

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURATION ---
const DESTINATION_WALLET = new PublicKey('6SgijZJtGwFdGbnctyXpr3xinM1ZJ4yXMYhsUJKLPHPH');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // Mainnet USDC
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(SOLANA_RPC, 'confirmed');

// MASTER FUNDING WALLET: Required to pay rent / transaction gas fees for user wallets.
// In production, load this securely from an environment variable (e.g., JSON array string or base58 string).
// const FUNDING_KEYPAIR = Keypair.fromSecretKey(Uint8Array.from([...]));

// In-memory store (use MongoDB/Postgres in production)
const userWallets = {}; // { userId: { publicKey, privateKey, expectedAmount, balance } }

/**
 * 1. Create or get a user's unique deposit wallet
 */
app.post('/api/wallet', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  if (!userWallets[userId]) {
    const keypair = Keypair.generate();
    userWallets[userId] = {
      publicKey: keypair.publicKey.toBase58(),
      privateKey: Array.from(keypair.secretKey),
      expectedAmount: 0,
      balance: 0
    };
  }

  res.json({ walletAddress: userWallets[userId].publicKey });
});

/**
 * 2. Create a payment intent (sets target deposit amount)
 */
app.post('/api/intent', (req, res) => {
  const { userId, expectedAmount } = req.body;
  if (!userWallets[userId]) return res.status(404).json({ error: 'Wallet not found. Create wallet first.' });

  userWallets[userId].expectedAmount = parseFloat(expectedAmount);
  res.json({ 
    status: 'Intent created', 
    expectedAmount: userWallets[userId].expectedAmount,
    walletAddress: userWallets[userId].publicKey
  });
});

/**
 * 3. Background worker to check balances and sweep incoming USDC
 */
async function monitorPayments() {
  setInterval(async () => {
    for (const userId in userWallets) {
      const user = userWallets[userId];
      
      try {
        const userPubkey = new PublicKey(user.publicKey);
        const userWallet = Keypair.fromSecretKey(new Uint8Array(user.privateKey));

        // Check SOL balance for gas fees
        let solBalance = await connection.getBalance(userPubkey);

        // If the user's generated wallet has no SOL to pay transaction fees, fund it automatically
        if (solBalance < 0.002 * LAMPORTS_PER_SOL) {
          console.log(`[Wallet ${userId}] Insufficient gas SOL. Funding from master...`);
          
          /* 
            // UNCOMMENT IN PRODUCTION ONCE FUNDING_KEYPAIR IS CONFIGURED:
            const fundTx = new Transaction().add(
              SystemProgram.transfer({
                fromPubkey: FUNDING_KEYPAIR.publicKey,
                toPubkey: userPubkey,
                lamports: 0.003 * LAMPORTS_PER_SOL // give it enough for rent + sweep fee
              })
            );
            await sendAndConfirmTransaction(connection, fundTx, [FUNDING_KEYPAIR]);
            continue; // Re-check on next loop iteration after funding settles
          */
          continue; 
        }

        // Check USDC balance token accounts
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(userPubkey, {
          mint: USDC_MINT
        });

        if (tokenAccounts.value.length > 0) {
          const usdcBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;

          if (usdcBalance > 0) {
            console.log(`[Wallet ${userId}] Found ${usdcBalance} USDC. Sweeping to main wallet...`);

            // Get or create Associated Token Accounts for sender and destination
            const destinationTokenAccount = await getOrCreateAssociatedTokenAccount(
              connection,
              userWallet,
              USDC_MINT,
              DESTINATION_WALLET
            );

            const userTokenAccount = await getOrCreateAssociatedTokenAccount(
              connection,
              userWallet,
              USDC_MINT,
              userPubkey
            );

            // Construct transfer transaction (USDC uses 6 decimals)
            const transaction = new Transaction().add(
              createTransferInstruction(
                userTokenAccount.address,
                destinationTokenAccount.address,
                userWallet.publicKey,
                Math.round(usdcBalance * 1e6) 
              )
            );

            const signature = await sendAndConfirmTransaction(connection, transaction, [userWallet]);
            console.log(`[Wallet ${userId}] Successfully swept! Tx Signature: ${signature}`);
            
            // Update ledger
            user.balance += usdcBalance;
            user.expectedAmount = Math.max(0, user.expectedAmount - usdcBalance);
          }
        }
      } catch (error) {
        console.error(`Error monitoring wallet ${userId}:`, error.message);
      }
    }
  }, 15000); // Scans every 15 seconds
}

// Start background monitor loop
monitorPayments();

app.get('/', (req, res) => {
  res.send('Buxify Payment Gateway Server is running successfully.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Destination Master Wallet: ${DESTINATION_WALLET.toBase58()}`);
});
