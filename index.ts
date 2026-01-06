/**
 * Unreel AI x402 MCP Server
 *
 * An MCP server that enables AI agents to generate videos using Unreel AI
 * with automatic x402 payment handling on Solana (USDC) via Kora gasless transactions.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  Keypair,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { config } from "dotenv";
import { z } from "zod";
import { base58 } from "@scure/base";

config();

// Configuration
const UNREEL_API_URL = process.env.UNREEL_API_URL || "https://x402.unreel.ai";
const X402_SERVICE_URL = process.env.X402_SERVICE_URL || "https://x402.infraxa.ai";
const SVM_PRIVATE_KEY = process.env.SVM_PRIVATE_KEY as string;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

if (!SVM_PRIVATE_KEY) {
  throw new Error("SVM_PRIVATE_KEY environment variable is required (base58-encoded Solana private key)");
}

// Load wallet from base58 private key
const secretKey = base58.decode(SVM_PRIVATE_KEY);
const wallet = Keypair.fromSecretKey(secretKey);

console.error(`[unreel-x402-mcp] Wallet: ${wallet.publicKey.toBase58()}`);

interface PaymentRequirements {
  network: string;
  payTo: string;
  asset: string;
  maxAmountRequired: string;
  extra?: {
    feePayer?: string;
    x402_tenant_id?: string;
    x402_service_url?: string;
  };
}

interface PaymentInstruction {
  programAddress: string;
  accounts: Array<{
    address: string;
    role: number;
  }>;
  data: number[] | { data: number[] } | Record<string, number>;
}

/**
 * Handle the full x402 payment flow with Kora gasless transactions
 */
async function handlePayment(requirements: PaymentRequirements): Promise<string> {
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  const tenantId = requirements.extra?.x402_tenant_id || "unreel-ai";

  const payTo = new PublicKey(requirements.payTo);
  const usdcMint = new PublicKey(requirements.asset);
  const amount = Number(requirements.maxAmountRequired);

  console.error(`[unreel-x402-mcp] Processing payment: ${amount / 1_000_000} USDC to ${requirements.payTo.substring(0, 8)}...`);

  // Step 1: Get fee payer from x402 service
  const supportedRes = await fetch(`${X402_SERVICE_URL}/supported/${tenantId}`);
  const supportedInfo = await supportedRes.json();

  if (!supportedInfo.kinds?.[0]?.extra?.feePayer) {
    throw new Error("Failed to get fee payer from x402 service");
  }
  const feePayerAddress = supportedInfo.kinds[0].extra.feePayer;
  console.error(`[unreel-x402-mcp] Fee payer: ${feePayerAddress}`);

  // Step 2: Build base USDC transfer transaction
  const senderUsdcAccount = await getAssociatedTokenAddress(usdcMint, wallet.publicKey);
  const recipientUsdcAccount = await getAssociatedTokenAddress(usdcMint, payTo);
  const { blockhash } = await connection.getLatestBlockhash();

  let transaction = new Transaction();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = new PublicKey(feePayerAddress);

  transaction.add(
    createTransferInstruction(
      senderUsdcAccount,
      recipientUsdcAccount,
      wallet.publicKey,
      amount,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  // Step 3: Get payment instruction from x402/Kora
  const baseTx = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");

  const paymentInstructionRes = await fetch(`${X402_SERVICE_URL}/payment-instruction/${tenantId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transaction: baseTx,
      feeToken: requirements.asset,
      sourceWallet: wallet.publicKey.toBase58(),
    }),
  });

  const paymentInstructionData = await paymentInstructionRes.json();

  if (paymentInstructionData.error || !paymentInstructionData.payment_instruction) {
    throw new Error(`Failed to get payment instruction: ${paymentInstructionData.error || "No instruction returned"}`);
  }

  const paymentInstruction: PaymentInstruction = paymentInstructionData.payment_instruction;
  const signerAddress = paymentInstructionData.signer_address;
  console.error(`[unreel-x402-mcp] Got payment instruction, signer: ${signerAddress}`);

  // Step 4: Rebuild transaction with payment instruction
  transaction = new Transaction();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = new PublicKey(signerAddress);

  // Add USDC transfer
  transaction.add(
    createTransferInstruction(
      senderUsdcAccount,
      recipientUsdcAccount,
      wallet.publicKey,
      amount,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  // Parse and add Kora instruction
  let dataBuffer: Buffer;
  if (Array.isArray(paymentInstruction.data)) {
    dataBuffer = Buffer.from(paymentInstruction.data);
  } else if ((paymentInstruction.data as any)?.data) {
    dataBuffer = Buffer.from((paymentInstruction.data as any).data);
  } else if (typeof paymentInstruction.data === "object") {
    dataBuffer = Buffer.from(Object.values(paymentInstruction.data) as number[]);
  } else {
    dataBuffer = Buffer.from([]);
  }

  const koraInstruction = new TransactionInstruction({
    keys: paymentInstruction.accounts.map((account) => ({
      pubkey: new PublicKey(account.address),
      isSigner: account.role === 2 || account.role === 3,
      isWritable: account.role === 1 || account.role === 3,
    })),
    programId: new PublicKey(paymentInstruction.programAddress),
    data: dataBuffer,
  });

  transaction.add(koraInstruction);

  // Step 5: Sign and settle
  transaction.partialSign(wallet);
  const signedTx = transaction.serialize({ requireAllSignatures: false }).toString("base64");

  const settleRes = await fetch(`${X402_SERVICE_URL}/settle/${tenantId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paymentPayload: {
        x402Version: 2,
        scheme: "exact",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        payload: { transaction: signedTx },
      },
      paymentRequirements: {
        x402Version: 2,
        scheme: "exact",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        maxAmountRequired: requirements.maxAmountRequired,
        resource: `${UNREEL_API_URL}/api/generate-x402`,
        payTo: requirements.payTo,
        asset: requirements.asset,
        extra: { feePayer: signerAddress },
      },
    }),
  });

  const settleData = await settleRes.json();

  if (!settleData.success) {
    throw new Error(`Settlement failed: ${settleData.errorReason || settleData.error || "Unknown error"}`);
  }

  console.error(`[unreel-x402-mcp] Payment settled: ${settleData.transaction}`);
  return settleData.transaction;
}

/**
 * Make a paid API request with x402 payment handling
 */
async function makePaidRequest(endpoint: string, body: any): Promise<any> {
  // Step 1: Make initial request to get payment requirements
  const initialRes = await fetch(`${UNREEL_API_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (initialRes.status !== 402) {
    // No payment required or different error
    if (!initialRes.ok) {
      const error = await initialRes.text();
      throw new Error(`API error (${initialRes.status}): ${error}`);
    }
    return initialRes.json();
  }

  // Step 2: Parse payment requirements
  const paymentRequired = await initialRes.json();
  const requirements: PaymentRequirements = paymentRequired.accepts[0];

  console.error(`[unreel-x402-mcp] Payment required: ${Number(requirements.maxAmountRequired) / 1_000_000} USDC`);

  // Step 3: Handle payment
  const txSignature = await handlePayment(requirements);

  // Step 4: Make request with payment proof
  const paymentPayload = {
    x402Version: 2,
    scheme: "exact",
    network: requirements.network,
    payload: { transaction: txSignature },
  };

  const paidRes = await fetch(`${UNREEL_API_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PAYMENT": Buffer.from(JSON.stringify(paymentPayload)).toString("base64"),
    },
    body: JSON.stringify(body),
  });

  if (!paidRes.ok) {
    const error = await paidRes.text();
    throw new Error(`Paid request failed (${paidRes.status}): ${error}`);
  }

  return paidRes.json();
}

/**
 * Poll for job completion
 */
async function pollJobStatus(jobId: string, maxAttempts = 60, initialDelay = 5000): Promise<any> {
  let attempt = 0;
  let delay = initialDelay;

  while (attempt < maxAttempts) {
    const res = await fetch(`${UNREEL_API_URL}/api/jobs/${jobId}`);
    const job = await res.json();

    if (job.status === "completed") {
      return job;
    } else if (job.status === "failed") {
      throw new Error(`Job failed: ${job.error || "Unknown error"}`);
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 1.2, 30000);
    attempt++;
  }

  throw new Error(`Job timed out after ${maxAttempts} attempts`);
}

/**
 * Main entry point
 */
async function main() {
  console.error("[unreel-x402-mcp] Starting Unreel AI x402 MCP Server...");
  console.error(`[unreel-x402-mcp] API: ${UNREEL_API_URL}`);
  console.error(`[unreel-x402-mcp] x402 Service: ${X402_SERVICE_URL}`);

  const server = new McpServer({
    name: "Unreel AI Video Generator",
    version: "1.0.0",
  });

  // Tool: Generate video
  server.tool(
    "generate-video",
    "Generate a short video from a text prompt using Unreel AI. Costs ~$25 USDC per video (gasless). Returns a job ID for tracking.",
    {
      prompt: z.string().describe("Text description of the video to generate"),
      reference_images: z.array(z.string()).optional().describe("Optional array of image URLs for style/character reference. AI auto-classifies into character refs vs backgrounds."),
      webhook_url: z.string().optional().describe("Optional URL to POST results when job completes"),
      webhook_secret: z.string().optional().describe("Optional secret for HMAC-SHA256 signature in X-Webhook-Signature header"),
      wait_for_completion: z.boolean().optional().describe("If true, wait for video completion. Default: false"),
    },
    async ({ prompt, reference_images, webhook_url, webhook_secret, wait_for_completion = false }) => {
      console.error(`[unreel-x402-mcp] Generating video: "${prompt.substring(0, 50)}..."`);
      if (reference_images?.length) {
        console.error(`[unreel-x402-mcp] Reference images: ${reference_images.length}`);
      }
      if (webhook_url) {
        console.error(`[unreel-x402-mcp] Webhook: ${webhook_url}`);
      }

      try {
        const requestBody: any = { script_text: prompt };
        if (reference_images?.length) requestBody.reference_images = reference_images;
        if (webhook_url) requestBody.webhook_url = webhook_url;
        if (webhook_secret) requestBody.webhook_secret = webhook_secret;

        const response = await makePaidRequest("/api/generate-x402", requestBody);

        const { job_id, status, status_url } = response;
        console.error(`[unreel-x402-mcp] Job created: ${job_id}`);

        if (wait_for_completion) {
          console.error(`[unreel-x402-mcp] Waiting for completion...`);
          const result = await pollJobStatus(job_id);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                job_id,
                status: "completed",
                video_url: result.video_url,
                message: "Video generated successfully!",
              }, null, 2),
            }],
          };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              job_id,
              status,
              status_url,
              message: "Video generation started. Use check-job-status to monitor progress.",
            }, null, 2),
          }],
        };
      } catch (error: any) {
        console.error(`[unreel-x402-mcp] Error:`, error.message);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error.message || "Unknown error",
            }, null, 2),
          }],
        };
      }
    }
  );

  // Tool: Check job status
  server.tool(
    "check-job-status",
    "Check the status of a video generation job",
    {
      job_id: z.string().describe("The job ID returned from generate-video"),
    },
    async ({ job_id }) => {
      try {
        const res = await fetch(`${UNREEL_API_URL}/api/jobs/${job_id}`);
        const job = await res.json();

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              job_id,
              status: job.status,
              video_url: job.video_url || null,
              error: job.error || null,
              is_complete: job.status === "completed" || job.status === "failed",
            }, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error.message || "Failed to check job status",
            }, null, 2),
          }],
        };
      }
    }
  );

  // Tool: Get payment info
  server.tool(
    "get-payment-info",
    "Get current pricing and payment information",
    {},
    async () => {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            price_usdc: "25.00",
            network: "solana",
            asset: "USDC (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)",
            gas_fees: "Free (sponsored by Kora)",
            wallet: wallet.publicKey.toBase58(),
          }, null, 2),
        }],
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[unreel-x402-mcp] Server started!");
}

main().catch((error) => {
  console.error("[unreel-x402-mcp] Fatal error:", error);
  process.exit(1);
});
