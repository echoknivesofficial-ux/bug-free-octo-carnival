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
const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'); // Devnet USDC
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
const connection = new Connection(SOLANA_RPC, 'confirmed');

const userWallets = {};

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
    console.log(`[New Wallet Created] User ID: ${userId} -> Address: ${userWallets[userId].publicKey}`);
  }

  res.json({ walletAddress: userWallets[userId].publicKey });
});

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

async function monitorPayments() {
  setInterval(async () => {
    for (const userId in userWallets) {
      const user = userWallets[userId];
      
      try {
        const userPubkey = new PublicKey(user.publicKey);
        const userWallet = Keypair.fromSecretKey(new Uint8Array(user.privateKey));
        const solBalance = await connection.getBalance(userPubkey);

        if (solBalance < 0.002 * LAMPORTS_PER_SOL) {
          continue; 
        }

        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(userPubkey, {
          mint: USDC_MINT
        });

        if (tokenAccounts.value.length > 0) {
          const usdcBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;

          if (usdcBalance > 0) {
            console.log(`[Detected] User Wallet (${user.publicKey}) received ${usdcBalance} USDC. Preparing sweep...`);

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
                Math.round(usdcBalance * 1e6) 
              )
            );

            const signature = await sendAndConfirmTransaction(connection, transaction, [userWallet]);
            
            console.log(`========================================`);
            console.log(`[SWEEP SUCCESS] User Wallet sent ${usdcBalance} USDC to Master Wallet!`);
            console.log(`From User Address: ${user.publicKey}`);
            console.log(`To Master Wallet:  ${DESTINATION_WALLET.toBase58()}`);
            console.log(`Tx Signature:      ${signature}`);
            console.log(`========================================`);
            
            user.balance += usdcBalance;
            user.expectedAmount = Math.max(0, user.expectedAmount - usdcBalance);
          }
        }
      } catch (error) {
        console.error(`Error monitoring wallet for user ${userId}:`, error.message);
      }
    }
  }, 15000);
}

monitorPayments();

app.get('/', (req, res) => {
  res.send('Buxify Solana Devnet Payment Gateway Server running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Master Wallet Destination: ${DESTINATION_WALLET.toBase58()}`);
});
