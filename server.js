const express = require('express');
const cors = require('cors');
const { 
  Connection, 
  Keypair, 
  PublicKey, 
  Transaction, 
  sendAndConfirmTransaction
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

// In-memory store for demo purposes
// In production, use MongoDB/Postgres to persist this data
const userWallets = {}; // { userId: { publicKey, privateKey, expectedAmount, totalReceived } }

/**
 * Endpoint: Create or get a user's unique deposit wallet
 */
app.post('/api/wallet', async (req, res) => {
  const { userId } = req.body;
  
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  if (!userWallets[userId]) {
    const keypair = Keypair.generate();
    userWallets[userId] = {
      publicKey: keypair.publicKey.toBase58(),
      privateKey: Array.from(keypair.secretKey),
      expectedAmount: 0,
      totalReceived: 0
    };
  }

  res.json({ walletAddress: userWallets[userId].publicKey });
});

/**
 * Endpoint: Set expected amount
 */
app.post('/api/intent', (req, res) => {
  const { userId, expectedAmount } = req.body;
  
  if (!userWallets[userId]) {
    return res.status(404).json({ error: 'Wallet not found.' });
  }

  // Reset total received for a new intent
  userWallets[userId].expectedAmount = parseFloat(expectedAmount);
  userWallets[userId].totalReceived = 0; 
  
  res.json({ 
    status: 'Intent created', 
    expectedAmount: userWallets[userId].expectedAmount,
    walletAddress: userWallets[userId].publicKey
  });
});

/**
 * NEW Endpoint: Check if payment is completed
 */
app.get('/api/check-payment/:userId', (req, res) => {
  const { userId } = req.params;
  const user = userWallets[userId];

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const isPaid = user.totalReceived >= user.expectedAmount && user.expectedAmount > 0;
  
  res.json({
    paid: isPaid,
    received: user.totalReceived,
    expected: user.expectedAmount
  });
});

/**
 * Background worker to check balances, sweep funds, and update totalReceived
 */
async function monitorPayments() {
  setInterval(async () => {
    for (const userId in userWallets) {
      const user = userWallets[userId];
      
      try {
        const userPubkey = new PublicKey(user.publicKey);
        const userWallet = Keypair.fromSecretKey(new Uint8Array(user.privateKey));
        const solBalance = await connection.getBalance(userPubkey);
        
        let usdcBalance = 0;
        try {
          const tokenAccounts = await connection.getParsedTokenAccountsByOwner(userPubkey, {
            mint: USDC_MINT
          });

          if (tokenAccounts.value.length > 0) {
            usdcBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
          }
        } catch (e) {}

        if (usdcBalance > 0) {
          console.log(`[Wallet ${userId}] Found ${usdcBalance} USDC.`);
          
          if (solBalance < 0.001) {
            console.log(`[Wallet ${userId}] Insufficient SOL for gas. Cannot sweep.`);
            continue; 
          }

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

          const transaction = new Transaction().add(
            createTransferInstruction(
              userTokenAccount.address,
              destinationTokenAccount.address,
              userWallet.publicKey,
              usdcBalance * 1e6 
            )
          );

          const signature = await sendAndConfirmTransaction(
            connection,
            transaction,
            [userWallet]
          );

          console.log(`[Wallet ${userId}] Swept ${usdcBalance} USDC. Tx: ${signature}`);
          
          // IMPORTANT: Add to totalReceived so the frontend knows they paid
          user.totalReceived += usdcBalance;

          if (user.totalReceived >= user.expectedAmount) {
            console.log(`[Wallet ${userId}] Payment complete!`);
          }
        }
      } catch (error) {
        console.error(`Error monitoring wallet ${userId}:`, error.message);
      }
    }
  }, 10000); // Check every 10 seconds
}

monitorPayments();

app.get('/', (req, res) => {
  res.send('Buxify Payment Gateway is running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
