const { sendReport } = require('./telegramReporter'); // Pastikan file ini ada
const { ethers } = require('ethers');
const axios = require('axios');
const moment = require('moment-timezone');
require('dotenv').config();

// =========================================================================
// UTILITIES & KONSTANTA
// =========================================================================

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
    info: (msg) => console.log(`${colors.green}[✓] ${msg}${colors.reset}`),
    warn: (msg) => console.log(`${colors.yellow}[⚠] ${msg}${colors.reset}`),
    error: (msg) => console.log(`${colors.red}[✗] ${msg}${colors.reset}`),
    success: (msg) => console.log(`${colors.green}[✔] ${msg}${colors.reset}`),
    loading: (msg) => console.log(`${colors.cyan}[⏳] ${msg}${colors.reset}`),
    step: (msg) => console.log(`${colors.white}[➤] ${msg}${colors.reset}`),
    banner: () => {
        console.log(`${colors.cyan}${colors.bold}`);
        console.log(`---------------------------------------------`);
        console.log(`   Union Testnet OOP Bot - Recode By 0x062  `);
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

const CONTRACT_ADDRESS = '0x5FbE74A283f7954f10AA04C2eDf55578811aeb03';
const USDC_ADDRESS = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const GRAPHQL_ENDPOINT = 'https://graphql.union.build/v1/graphql';
const BASE_EXPLORER_URL = 'https://sepolia.etherscan.io';
const UNION_URL = 'https://app.union.build/explorer';

const explorer = {
  tx: (txHash) => `${BASE_EXPLORER_URL}/tx/${txHash}`,
  address: (address) => `${BASE_EXPLORER_URL}/address/${address}`,
};

const union = {
  tx: (txHash) => `${UNION_URL}/transfers/${txHash}`,
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timelog = () => moment().tz('Asia/Jakarta').format('HH:mm:ss | DD-MM-YYYY');

// =========================================================================
// CLASS UnionBot
// =========================================================================

class UnionBot {
    constructor(privateKey, babylonAddress) {
        if (!privateKey) {
            logger.error("Private key tidak ditemukan. Mohon periksa .env!");
            throw new Error("Private key is required.");
        }

        const rpcUrl = process.env.RPC_URL_PRIV;
        if (!rpcUrl) {
            logger.error("RPC_URL_PRIV tidak ditemukan. Mohon periksa .env!");
            throw new Error("RPC URL is required.");
        }

        this.provider = new ethers.providers.JsonRpcProvider(rpcUrl);
        this.wallet = new ethers.Wallet(privateKey, this.provider);
        this.babylonAddress = babylonAddress || null;

        this.ucs03Contract = new ethers.Contract(CONTRACT_ADDRESS, UCS03_ABI, this.wallet);
        this.usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, this.wallet);

        logger.info(`Bot diinisialisasi untuk wallet: ${this.wallet.address}`);
        logger.info(`Menggunakan RPC: ${rpcUrl}`);
    }

    async _pollPacketHash(txHash, retries = 50, intervalMs = 30000) {
        const headers = {
            accept: 'application/graphql-response+json, application/json',
            'accept-encoding': 'gzip, deflate, br, zstd',
            'accept-language': 'en-US,en;q=0.9,id;q=0.8',
            'content-type': 'application/json',
            origin: 'https://app.union.build',
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

        logger.loading(`Memulai polling packet hash untuk ${txHash}...`);
        for (let i = 0; i < retries; i++) {
            try {
                const res = await axios.post(GRAPHQL_ENDPOINT, data, { headers });
                const result = res.data?.data?.v2_transfers;
                if (result && result.length > 0 && result[0].packet_hash) {
                    return result[0].packet_hash;
                }
            } catch (e) {
                logger.error(`Polling error: ${e.message}`);
            }
            logger.step(`Mencoba lagi polling dalam ${intervalMs / 1000} detik... (${i + 1}/${retries})`);
            await delay(intervalMs);
        }
        logger.warn(`Tidak menemukan packet hash setelah ${retries} percobaan.`);
        return null;
    }

    async _checkBalanceAndApprove() {
    try {
        const balance = await this.usdcContract.balanceOf(this.wallet.address);
        if (balance === 0n) {
            logger.error(`${this.wallet.address} tidak punya USDC. Mohon isi saldo!`);
            return false;
        }
        logger.info(`Saldo USDC: ${ethers.utils.formatUnits(balance, 6)}`);

        const allowance = await this.usdcContract.allowance(this.wallet.address, CONTRACT_ADDRESS);
        if (allowance < balance) { 
            logger.loading(`USDC belum di-approve atau kurang. Mengirim transaksi approve...`);
            
            // !! PERUBAHAN DI SINI !!
            const approveAmount = ethers.constants.MaxUint256; // Gunakan ethers.constants.MaxUint256

            const tx = await this.usdcContract.approve(CONTRACT_ADDRESS, approveAmount);
            logger.loading(`Menunggu konfirmasi approve... ${explorer.tx(tx.hash)}`);
            const receipt = await tx.wait();
            logger.success(`Approve berhasil: ${explorer.tx(receipt.hash)}`);
            await delay(5000); 
        } else {
            logger.info("USDC sudah di-approve.");
        }
        return true;
    } catch (err) {
        // Log error yang lebih detail jika perlu
        logger.error(`Cek Saldo/Approve Gagal: ${err.message}`);
        console.error(err); // <-- Tambahkan ini untuk melihat detail error di console
        return false;
    }
}

    _buildOperand(destination) {
        const senderHex = this.wallet.address.slice(2).toLowerCase();
        let recipientHex = senderHex;
        let operand = '';

        if (destination === 'babylon') {
            if (!this.babylonAddress) throw new Error("Alamat Babylon diperlukan!");
            recipientHex = Buffer.from(this.babylonAddress, "utf8").toString("hex");
            // =========================================================================
            // !! SANGAT PENTING: GANTI DENGAN OPERAND BABYLON ANDA YANG PANJANG !!
            operand = `0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000002710000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000002600000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000027100000000000000000000000000000000000000000000000000000000000000014${senderHex}000000000000000000000000000000000000000000000000000000000000000000000000000000000000002a${recipientHex}0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000141c7d4b196cb0c7b01d743fbc6116a902379c72380000000000000000000000000000000000000000000000000000000000000000000000000000000000000004555344430000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000045553444300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003e62626e317a7372763233616b6b6778646e77756c3732736674677632786a74356b68736e743377776a687030666668363833687a7035617135613068366e0000`;
            // =========================================================================
        } else { // Holesky
            // =========================================================================
            // !! SANGAT PENTING: GANTI DENGAN OPERAND HOLESKY ANDA YANG PANJANG !!
            operand = `0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000002c00000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000001c000000000000000000000000000000000000000000000000000000000000027100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000024000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000028000000000000000000000000000000000000000000000000000000000000027100000000000000000000000000000000000000000000000000000000000000014${senderHex}0000000000000000000000000000000000000000000000000000000000000000000000000000000000000014${senderHex}00000000000000000000000000000000000000000000000000000000000000000000000000000000000000141c7d4b196cb0c7b01d743fbc6116a902379c72380000000000000000000000000000000000000000000000000000000000000000000000000000000000000004555344430000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000045553444300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001457978bfe465ad9b1c0bf80f6c1539d300705ea50000000000000000000000000`;
            // =========================================================================
        }
        return operand;
    }

    async send(destination) {
        let channelId;
        let destinationName;

        if (destination === 'babylon') {
            if (!this.babylonAddress) {
                 logger.warn("Alamat Babylon tidak ada, transaksi ke Babylon dilewati.");
                 return false;
            }
            destinationName = 'Babylon';
            channelId = 7;
        } else if (destination === 'holesky') {
            destinationName = 'Holesky';
            channelId = 8;
        } else {
            logger.error(`Tujuan tidak valid: ${destination}`);
            return false;
        }

        logger.loading(`Mencoba mengirim 1 transaksi ke ${destinationName} dari ${this.wallet.address}`);

        const canProceed = await this._checkBalanceAndApprove();
        if (!canProceed) return false;

        try {
            const operand = this._buildOperand(destination);
            const timeoutHeight = 0;
            const now = BigInt(Date.now()) * 1_000_000n;
            const oneDayNs = 86_400_000_000_000n;
            const timeoutTimestamp = (now + oneDayNs).toString();
            const timestampNow = Math.floor(Date.now() / 1000);
            const packed = ethers.utils.solidityPack(['address', 'uint256'], [this.wallet.address, timestampNow]);
            const salt = ethers.utils.keccak256(packed);
            const instruction = { version: 0, opcode: 2, operand };

            const tx = await this.ucs03Contract.send(channelId, timeoutHeight, timeoutTimestamp, salt, instruction);
            logger.loading(`Transaksi dikirim, menunggu konfirmasi... ${explorer.tx(tx.hash)}`);
            await tx.wait(1);

            await sendReport(`✅ Transaksi Confirmed! OOP Bot\nHash: ${tx.hash}\nWallet: ${this.wallet.address}`);
            logger.success(`${timelog()} | Transaksi Confirmed: ${explorer.tx(tx.hash)}`);

            const packetHash = await this._pollPacketHash(tx.hash);
            if (packetHash) {
                logger.success(`${timelog()} | Packet Submitted: ${union.tx(packetHash)}`);
            }
            console.log('');
            return true; // Sukses

        } catch (err) {
            logger.error(`Transaksi Gagal: ${err.message}`);
            console.error(err);
            return false; // Gagal
        }
    }

}

async function main() {
    logger.banner();

    process.on('SIGINT', () => {
        logger.info('Sinyal keluar diterima. Keluar dengan baik.');
        process.exit(0);
    });

    const JUMLAH_TRANSAKSI = 10; // <-- Tetapkan jumlah transaksi di sini
    const JEDA_ANTAR_TRANSAKSI_MS = 5000; // 30 detik (30 * 1000)

    try {
        // Inisialisasi Bot
        const bot = new UnionBot(
            process.env.PRIVATE_KEY_1,
            process.env.BABYLON_ADDRESS_1
        );

        let successCount = 0;
        let failureCount = 0;

        // Loop sebanyak JUMLAH_TRANSAKSI
        for (let i = 1; i <= JUMLAH_TRANSAKSI; i++) {
            logger.step(`================ Transaksi ${i}/${JUMLAH_TRANSAKSI} ================`);

            // Pilih tujuan acak di setiap iterasi
            const destinations = ['babylon', 'holesky'];
            const randomDest = destinations[Math.floor(Math.random() * destinations.length)];
            logger.info(`Memulai transaksi ke-${i}. Tujuan: ${randomDest}`);

            // Kirim transaksi (memanggil bot.send langsung)
            const success = await bot.send(randomDest);

            if (success) {
                successCount++;
                logger.success(`Transaksi ke-${i} Berhasil!`);
            } else {
                failureCount++;
                logger.error(`Transaksi ke-${i} Gagal atau Dilewati.`);
            }

            // Beri jeda jika bukan transaksi terakhir
            if (i < JUMLAH_TRANSAKSI) {
                logger.loading(`Menunggu ${JEDA_ANTAR_TRANSAKSI_MS / 1000} detik sebelum transaksi berikutnya...`);
                await delay(JEDA_ANTAR_TRANSAKSI_MS);
            }
            console.log(''); // Beri spasi antar log transaksi
        }

        // Tampilkan ringkasan
        logger.info("================ RINGKASAN ================");
        logger.success(`Total Berhasil: ${successCount}`);
        logger.error(`Total Gagal   : ${failureCount}`);
        logger.info("=========================================");

        // Keluar dengan status 0 (sukses) karena script telah selesai menjalankan tugasnya
        process.exit(0);

    } catch (error) {
        logger.error(`Terjadi error fatal di main: ${error.message}`);
        console.error(error);
        process.exit(1); // Keluar dengan status 1 jika ada error fatal
    }
}

// Panggil fungsi main
main();
