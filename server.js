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
const DESTINATION_WALLET = new PublicKey('6SgijZJtGwFdGbnctyXpr3xinM1ZJ4yXMYhsUJKLPHPH'); // Your Master Wallet
const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'); // Devnet USDC (Change to Mainnet 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' later)
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
const connection = new Connection(SOLANA_RPC, 'confirmed');

// MASTER FUNDING WALLET: Required to pay network gas fees for user wallets.
// In production, load your master secret key array securely from environment variables:
// const FUNDING_KEYPAIR = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.MASTER_PRIVATE_KEY)));
// For testing locally right now, you can generate or paste one:
const FUNDING_KEYPAIR = Keypair.generate(); // ⚠️ Replace with your actual funded master keypair in production!

// In-store memory database for user wallets
const userWallets = {}; // { userId: { publicKey, privateKey, expectedAmount, balance } }

/**
 * 1. Create a unique deposit wallet per user on the backend
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
    console.log(`[Wallet Generated] User ID: ${userId} -> Address: ${userWallets[userId].publicKey}`);
  }

  res.json({ walletAddress: userWallets[userId].publicKey });
});

/**
 * 2. Set payment target intent
 */
app.post('/api/intent', (req, res) => {
  const { userId, expectedAmount } = req.body;
  if (!userWallets[userId]) return res.status(404).json({ error: 'Wallet not found.' });

  userWallets[userId].expectedAmount = parseFloat(expectedAmount);
  res.json({ 
    status: 'Intent created', 
    expectedAmount: userWallets[userId].expectedAmount,
    walletAddress: userWallets[userId].publicKey
  });
});

/**
 * 3. Background worker to check balances and auto-sweep funds to Master Wallet
 */
async function monitorPayments() {
  setInterval(async () => {
    for (const userId in userWallets) {
      const user = userWallets[userId];
      
      try {
        const userPubkey = new PublicKey(user.publicKey);
        const userWallet = Keypair.fromSecretKey(new Uint8Array(user.privateKey));

        // Check SOL balance for network gas fees
        let solBalance = await connection.getBalance(userPubkey);

        // If user wallet lacks gas SOL, automatically fund it from the master funding wallet
        if (solBalance < 0.002 * LAMPORTS_PER_SOL) {
          console.log(`[Gas Auto-Funding] Sending 0.003 SOL to user wallet ${user.publicKey} for fees...`);
          try {
            const fundTx = new Transaction().add(
              SystemProgram.transfer({
                fromPubkey: FUNDING_KEYPAIR.publicKey,
                toPubkey: userPubkey,
                lamports: 0.003 * LAMPORTS_PER_SOL
              })
            );
            await sendAndConfirmTransaction(connection, fundTx, [FUNDING_KEYPAIR]);
            continue; // Skip to next loop iteration to let the SOL deposit settle
          } catch (fundError) {
            console.error(`[Funding Error] Could not fund gas for ${user.publicKey}:`, fundError.message);
            continue;
          }
        }

        // Check token balances (USDC)
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(userPubkey, {
          mint: USDC_MINT
        });

        if (tokenAccounts.value.length > 0) {
          const usdcBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;

          if (usdcBalance > 0) {
            console.log(`[Detection] User Wallet received ${usdcBalance} USDC. Sweeping to master wallet...`);

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

            // Construct transaction instruction to move tokens (USDC uses 6 decimal places)
            const transaction = new Transaction().add(
              createTransferInstruction(
                userTokenAccount.address,
                destinationTokenAccount.address,
                userWallet.publicKey,
                Math.round(usdcBalance * 1e6) 
              )
            );

            // Sign and broadcast transaction using the user's secret key stored on server
            const signature = await sendAndConfirmTransaction(connection, transaction, [userWallet]);
            
            // CONSOLE LOG OUTPUT PRINTED IN RENDER/TERMINAL
            console.log(`==================================================`);
            console.log(`🚀 [SWEEP SUCCESS] Funds automatically sent to Master!`);
            console.log(`💰 Amount:            ${usdcBalance} USDC`);
            console.log(`📤 From User Wallet:  ${user.publicKey}`);
            console.log(`📥 To Master Wallet:  ${DESTINATION_WALLET.toBase58()}`);
            console.log(`🔗 Tx Signature:      ${signature}`);
            console.log(`==================================================`);
            
            // Update internal ledger
            user.balance += usdcBalance;
            user.expectedAmount = Math.max(0, user.expectedAmount - usdcBalance);
          }
        }
      } catch (error) {
        console.error(`Error monitoring wallet for user ${userId}:`, error.message);
      }
    }
  }, 15000); // Scans every 15 seconds
}

// Start the background monitoring loop
monitorPayments();

app.get('/', (req, res) => {
  res.send('Buxify Automated Payment Gateway Server is running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Master Destination Wallet: ${DESTINATION_WALLET.toBase58()}`);
});
