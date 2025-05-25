const fs = require('fs');
const path = require('path');
const { sendReport } = require('./telegramReporter');
const { ethers } = require('ethers');
const axios = require('axios');
const moment = require('moment-timezone');
const readline = require('readline');
const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
require('dotenv').config();

const colors = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  white: "\x1b[37m",
  bold: "\x1b[1m"
};

const logger = {
  info: (msg) => console.log(`${colors.green}[âœ“] ${msg}${colors.reset}`),
  warn: (msg) => console.log(`${colors.yellow}[âš ] ${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}[âœ—] ${msg}${colors.reset}`),
  success: (msg) => console.log(`${colors.green}[âœ…] ${msg}${colors.reset}`),
  loading: (msg) => console.log(`${colors.cyan}[âŸ³] ${msg}${colors.reset}`),
  step: (msg) => console.log(`${colors.white}[âž¤] ${msg}${colors.reset}`),
  banner: () => {
    console.log(`${colors.cyan}${colors.bold}`);
    console.log(`---------------------------------------------`);
    console.log(`  Union Testnet Auto Bot - Airdrop Insiders  `);
    console.log(`---------------------------------------------${colors.reset}`);
    console.log();
  }
};

const UCS03_ABI = [
  {
    inputs: [
      { internalType: 'uint32', name: 'channelId', type: 'uint32' },
      { internalType: 'uint64', name: 'timeoutHeight', type: 'uint64' },
      { internalType: 'uint64', name: 'timeoutTimestamp', type: 'uint64' },
      { internalType: 'bytes32', name: 'salt', type: 'bytes32' },
      {
        components: [
          { internalType: 'uint8', name: 'version', type: 'uint8' },
          { internalType: 'uint8', name: 'opcode', type: 'uint8' },
          { internalType: 'bytes', name: 'operand', type: 'bytes' },
        ],
        internalType: 'struct Instruction',
        name: 'instruction',
        type: 'tuple',
      },
    ],
    name: 'send',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];

const USDC_ABI = [
  {
    constant: true,
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    type: 'function',
    stateMutability: 'view',
  },
  {
    constant: true,
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: '', type: 'uint256' }],
    type: 'function',
    stateMutability: 'view',
  },
  {
    constant: false,
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    type: 'function',
    stateMutability: 'nonpayable',
  },
];

const contractAddress = '0x5FbE74A283f7954f10AA04C2eDf55578811aeb03';
const USDC_ADDRESS = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const graphqlEndpoint = 'https://graphql.union.build/v1/graphql';
const baseExplorerUrl = 'https://sepolia.etherscan.io';
const unionUrl = 'https://app.union.build/explorer';

const rpcProviders = [
  new ethers.providers.JsonRpcProvider(process.env.RPC_URL_PRIV)
];
let currentRpcProviderIndex = 0;

function provider() {
  return rpcProviders[currentRpcProviderIndex];
}

function rotateRpcProvider() {
  currentRpcProviderIndex = (currentRpcProviderIndex + 1) % rpcProviders.length;
  return provider();
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askQuestion(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

const explorer = {
  tx: (txHash) => `${baseExplorerUrl}/tx/${txHash}`,
  address: (address) => `${baseExplorerUrl}/address/${address}`,
};

const union = {
  tx: (txHash) => `${unionUrl}/transfers/${txHash}`,
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function timelog() {
  return moment().tz('Asia/Jakarta').format('HH:mm:ss | DD-MM-YYYY');
}

function header() {
  process.stdout.write('\x1Bc');
  logger.banner();
}

async function pollPacketHash(txHash, retries = 50, intervalMs = 30000) {
  const headers = {
    accept: 'application/graphql-response+json, application/json',
    'accept-encoding': 'gzip, deflate, br, zstd',
    'accept-language': 'en-US,en;q=0.9,id;q=0.8',
    'content-type': 'application/json',
    origin: 'https://app-union.build',
    referer: 'https://app.union.build/',
    'user-agent': 'Mozilla/5.0',
  };
  const data = {
    query: `
      query ($submission_tx_hash: String!) {
        v2_transfers(args: {p_transaction_hash: $submission_tx_hash}) {
          packet_hash
        }
      }
    `,
    variables: {
      submission_tx_hash: txHash.startsWith('0x') ? txHash : `0x${txHash}`,
    },
  };

  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.post(graphqlEndpoint, data, { headers });
      const result = res.data?.data?.v2_transfers;
      if (result && result.length > 0 && result[0].packet_hash) {
        return result[0].packet_hash;
      }
    } catch (e) {
      logger.error(`Packet error: ${e.message}`);
    }
    await delay(intervalMs);
  }
  logger.warn(`No packet hash found after ${retries} retries.`);
  return null;
}

async function checkBalanceAndApprove(wallet, usdcAddress, spenderAddress) {
  const usdcContract = new ethers.Contract(usdcAddress, USDC_ABI, wallet);
  const balance = await usdcContract.balanceOf(wallet.address);
  if (balance === 0n) {
    logger.error(`${wallet.address} not have enough USDC. Fund your wallet first!`);
    return false;
  }

  const allowance = await usdcContract.allowance(wallet.address, spenderAddress);
  if (allowance === 0n) {
    logger.loading(`USDC is not allowance. Sending approve transaction....`);
    const approveAmount = ethers.MaxUint256;
    try {
      const tx = await usdcContract.approve(spenderAddress, approveAmount);
      const receipt = await tx.wait();
      logger.success(`Approve confirmed: ${explorer.tx(receipt.hash)}`);
      await delay(3000);
    } catch (err) {
      logger.error(`Approve failed: ${err.message}`);
      return false;
    }
  }
  return true;
}

async function sendFromWallet(walletInfo, maxTransaction, destination) {
  const wallet = new ethers.Wallet(walletInfo.privatekey, provider());
  let recipientAddress, destinationName, channelId, operand;

  if (destination === 'babylon') {
    recipientAddress = walletInfo.babylonAddress;
    destinationName = 'Babylon';
    channelId = 7;
    if (!recipientAddress) {
      logger.warn(`Skipping wallet '${walletInfo.name || 'Unnamed'}': Missing babylonAddress.`);
      return;
    }
  } else if (destination === 'holesky') {
    recipientAddress = wallet.address;
    destinationName = 'Holesky';
    channelId = 8;
  } else {
    logger.error(`Invalid destination: ${destination}`);
    return;
  }

  logger.loading(`Sending ${maxTransaction} Transaction Sepolia to ${destinationName} from ${wallet.address} (${walletInfo.name || 'Unnamed'})`);
  const shouldProceed = await checkBalanceAndApprove(wallet, USDC_ADDRESS, contractAddress);
  if (!shouldProceed) return;

  const contract = new ethers.Contract(contractAddress, UCS03_ABI, wallet);
  const senderHex = wallet.address.slice(2).toLowerCase();
  const recipientHex = destination === 'babylon' ? Buffer.from(recipientAddress, "utf8").toString("hex") : senderHex;
  const timeoutHeight = 0;

  if (destination === 'babylon') {
    operand = `0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000002710000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000002600000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000027100000000000000000000000000000000000000000000000000000000000000014${senderHex}000000000000000000000000000000000000000000000000000000000000000000000000000000000000002a${recipientHex}0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000141c7d4b196cb0c7b01d743fbc6116a902379c72380000000000000000000000000000000000000000000000000000000000000000000000000000000000000004555344430000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000045553444300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003e62626e317a7372763233616b6b6778646e77756c3732736674677632786a74356b68736e743377776a687030666668363833687a7035617135613068366e0000`;
  } else {
    operand = `0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000002c00000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000001c000000000000000000000000000000000000000000000000000000000000027100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000024000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000028000000000000000000000000000000000000000000000000000000000000027100000000000000000000000000000000000000000000000000000000000000014${senderHex}0000000000000000000000000000000000000000000000000000000000000000000000000000000000000014${senderHex}00000000000000000000000000000000000000000000000000000000000000000000000000000000000000141c7d4b196cb0c7b01d743fbc6116a902379c72380000000000000000000000000000000000000000000000000000000000000000000000000000000000000004555344430000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000045553444300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001457978bfe465ad9b1c0bf80f6c1539d300705ea50000000000000000000000000`;
  }

  for (let i = 1; i <= maxTransaction; i++) {
    logger.step(`${walletInfo.name || 'Unnamed'} | Transaction ${i}/${maxTransaction}`);
    const now = BigInt(Date.now()) * 1_000_000n;
    const oneDayNs = 86_400_000_000_000n;
    const timeoutTimestamp = (now + oneDayNs).toString();
    const timestampNow = Math.floor(Date.now() / 1000);
    const packed = ethers.utils.solidityPack(
      ['address', 'uint256'],
      [wallet.address, timestampNow]
      );
    const salt = ethers.utils.keccak256(packed);
    const instruction = {
      version: 0,
      opcode: 2,
      operand,
    };

    try {
      const tx = await contract.send(channelId, timeoutHeight, timeoutTimestamp, salt, instruction);
      await tx.wait(1);
      await sendReport(`âœ… Transaksi Confirmed! Report Union Bot\nHash: ${tx.hash}\nWallet: ${walletInfo.name || wallet.address}`);
      logger.success(`${timelog()} | ${walletInfo.name || 'Unnamed'} | Transaction Confirmed: ${explorer.tx(tx.hash)}`);
      const txHash = tx.hash.startsWith('0x') ? tx.hash : `0x${tx.hash}`;
      const packetHash = await pollPacketHash(txHash);
      if (packetHash) {
        logger.success(`${timelog()} | ${walletInfo.name || 'Unnamed'} | Packet Submitted: ${union.tx(packetHash)}`);
      }
      console.log('');
    } catch (err) {
      logger.error(`Failed for ${wallet.address}: ${err.message}`);
      console.log('');
    }

    if (i < maxTransaction) {
      await delay(1000);
    }
  }
}

async function main() {
  header();

  // Load 1 wallet seperti biasa
  const wallets = [];
  const pk = process.env.PRIVATE_KEY_1;
  if (!pk) {
    logger.error('No PRIVATE_KEY_1 in .env');
    process.exit(1);
  }
  wallets.push({ name: 'Wallet1', privatekey: pk, babylonAddress: process.env.BABYLON_ADDRESS_1 || '' });

  // === LOGIKA DAILY LIMIT ===
  const dailyLimit = 20;          // maks 10 tx per 24 jam
  let dailyCount = 0;             // counter transaksi hari ini
  let dayStart = Date.now();      // timestamp awal periode 24 jam

  // Tangkap Ctrl+C agar keluar dengan rapi
  process.on('SIGINT', () => {
    logger.info('Exit signal received.');
    rl.close();
    process.exit(0);
  });

  // Infinite loopâ€”akan reset tiap 24 jam
  while (true) {
    // 1) Jika sudah di atas limit, tunggu sampai 24 jam penuh:
    if (dailyCount >= dailyLimit) {
      const now = Date.now();
      const elapsed = now - dayStart;                     // ms yang udah berjalan
      const waitFor = Math.max(0, 8*60*60*1000 - elapsed);
      const minutes = Math.ceil(waitFor/1000/60);
      logger.info(`Reached ${dailyLimit} tx. Sleeping for ~${minutes} minutes until next 24h window.`);
      await delay(waitFor);

      // reset periode
      dayStart = Date.now();
      dailyCount = 0;
    }

    // 2) Lakukan transaksi sekali untuk wallet tunggal
    const walletInfo = wallets[0];
    const destinations = ['babylon', 'holesky'];
    const randomDest = destinations[Math.floor(Math.random() * destinations.length)];
    await sendFromWallet(walletInfo, 1, randomDest);
    logger.info(`Pilih random destination: ${randomDest}`);
    dailyCount++;
    logger.info(`${dailyCount}/${dailyLimit} transactions done in this 24h window.`);

    // 3) (opsional) jeda antar transaksiâ€”jika mau trans langsung berurutan, bisa skip ini
    await delay(30000);  // misal 1 detik
  }
}

main();
