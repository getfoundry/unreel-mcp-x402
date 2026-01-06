/**
 * Unreel AI x402 MCP Server
 *
 * An MCP server that enables AI agents to generate videos using Unreel AI
 * with automatic x402 payment handling on Solana (USDC).
 *
 * Features:
 * - Automatic 402 payment flow with gasless transactions via Kora
 * - Video generation from text prompts
 * - Job status polling
 * - Multi-tool support for Claude Desktop and other MCP clients
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import axios, { AxiosInstance } from "axios";
import { config } from "dotenv";
import { x402Client, wrapAxiosWithPayment } from "@x402/axios";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";
import { z } from "zod";

config();

// Configuration
const UNREEL_API_URL = process.env.UNREEL_API_URL || "https://x402.unreel.ai";
const SVM_PRIVATE_KEY = process.env.SVM_PRIVATE_KEY as string;

if (!SVM_PRIVATE_KEY) {
  throw new Error("SVM_PRIVATE_KEY environment variable is required (base58-encoded Solana private key)");
}

/**
 * Creates an axios client configured with x402 payment support for Solana.
 * This handles the automatic 402 payment flow when calling paid endpoints.
 */
async function createX402Client(): Promise<AxiosInstance> {
  const client = new x402Client();

  // Register Solana (SVM) payment scheme
  const svmSigner = await createKeyPairSignerFromBytes(base58.decode(SVM_PRIVATE_KEY));
  registerExactSvmScheme(client, { signer: svmSigner });

  console.error(`[unreel-x402-mcp] Wallet: ${svmSigner.address}`);

  return wrapAxiosWithPayment(
    axios.create({
      baseURL: UNREEL_API_URL,
      timeout: 120000, // 2 minutes for video generation
    }),
    client
  );
}

/**
 * Poll for job completion with exponential backoff.
 */
async function pollJobStatus(
  api: AxiosInstance,
  jobId: string,
  maxAttempts: number = 60,
  initialDelay: number = 5000
): Promise<any> {
  let attempt = 0;
  let delay = initialDelay;

  while (attempt < maxAttempts) {
    try {
      const response = await api.get(`/api/jobs/${jobId}`);
      const status = response.data.status;

      if (status === "completed") {
        return response.data;
      } else if (status === "failed") {
        throw new Error(`Job failed: ${response.data.error || "Unknown error"}`);
      }

      // Job still processing, wait and retry
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.2, 30000); // Cap at 30 seconds
      attempt++;
    } catch (error: any) {
      if (error.response?.status === 404) {
        throw new Error(`Job not found: ${jobId}`);
      }
      throw error;
    }
  }

  throw new Error(`Job timed out after ${maxAttempts} attempts`);
}

/**
 * Main entry point - initializes and starts the MCP server.
 */
async function main() {
  console.error("[unreel-x402-mcp] Starting Unreel AI x402 MCP Server...");

  const api = await createX402Client();

  // Create MCP server
  const server = new McpServer({
    name: "Unreel AI Video Generator",
    version: "1.0.0",
  });

  // Tool: Generate video from text prompt
  server.tool(
    "generate-video",
    "Generate a short video from a text prompt using Unreel AI. Costs ~$25 USDC per video. Returns a job ID for tracking.",
    {
      prompt: z.string().describe("Text description of the video to generate (e.g., 'A sunset over the ocean with gentle waves')"),
      wait_for_completion: z.boolean().optional().describe("If true, wait for video completion before returning. Default: false"),
    },
    async ({ prompt, wait_for_completion = false }) => {
      console.error(`[unreel-x402-mcp] Generating video: "${prompt.substring(0, 50)}..."`);

      try {
        // Make the paid API request - x402 handles payment automatically
        const response = await api.post("/api/generate-x402", {
          script_text: prompt,
        });

        const { job_id, status, status_url } = response.data;
        console.error(`[unreel-x402-mcp] Job created: ${job_id}`);

        if (wait_for_completion) {
          console.error(`[unreel-x402-mcp] Waiting for completion...`);
          const result = await pollJobStatus(api, job_id);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  job_id,
                  status: "completed",
                  video_url: result.video_url,
                  message: "Video generated successfully!",
                }, null, 2),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                job_id,
                status,
                status_url,
                message: "Video generation started. Use check-job-status to monitor progress.",
              }, null, 2),
            },
          ],
        };
      } catch (error: any) {
        console.error(`[unreel-x402-mcp] Error:`, error.message);

        // Handle payment errors specifically
        if (error.response?.status === 402) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: false,
                  error: "Payment required but failed",
                  details: "Ensure your wallet has sufficient USDC balance on Solana mainnet.",
                }, null, 2),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: error.message || "Unknown error",
                details: error.response?.data || null,
              }, null, 2),
            },
          ],
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
      console.error(`[unreel-x402-mcp] Checking job status: ${job_id}`);

      try {
        const response = await api.get(`/api/jobs/${job_id}`);
        const { status, video_url, error } = response.data;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                job_id,
                status,
                video_url: video_url || null,
                error: error || null,
                is_complete: status === "completed" || status === "failed",
              }, null, 2),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: error.message || "Failed to check job status",
              }, null, 2),
            },
          ],
        };
      }
    }
  );

  // Tool: Get payment info
  server.tool(
    "get-payment-info",
    "Get current pricing and payment information for video generation",
    {},
    async () => {
      try {
        const response = await api.get("/api/payment-info");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response.data, null, 2),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                price_usdc: "25.00",
                network: "solana",
                asset: "USDC",
                note: "Payment info endpoint unavailable, showing defaults",
              }, null, 2),
            },
          ],
        };
      }
    }
  );

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[unreel-x402-mcp] Server started successfully!");
}

main().catch((error) => {
  console.error("[unreel-x402-mcp] Fatal error:", error);
  process.exit(1);
});
