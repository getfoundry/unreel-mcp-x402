# Unreel AI x402 MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![x402](https://img.shields.io/badge/x402-payments-blue)](https://x402.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-green)](https://modelcontextprotocol.io)

An MCP (Model Context Protocol) server that enables AI agents to generate videos using [Unreel AI](https://unreel.ai) with automatic [x402](https://x402.org) payment handling on Solana.

## What is this?

This MCP server acts as a bridge between AI assistants (like Claude) and the Unreel AI video generation API. When you ask Claude to generate a video, this server:

1. Receives the request from Claude
2. Automatically handles USDC payment on Solana using the x402 protocol
3. Submits the video generation job
4. Returns the result to Claude

**No manual payment steps required** - the x402 protocol handles everything automatically.

## Features

- **Automatic x402 Payments** - Handles HTTP 402 payment flows using USDC on Solana
- **Gasless Transactions** - Gas fees sponsored via Kora (you only pay for the video)
- **Video Generation** - Generate short AI videos from text prompts
- **Job Tracking** - Monitor video generation progress
- **Claude Desktop Compatible** - Works with Claude Desktop and any MCP client

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/getfoundry/unreel-mcp-x402.git
cd unreel-mcp-x402
npm install
```

### 2. Get a Solana Wallet with USDC

You'll need a Solana wallet with USDC (mainnet) for payments. You can:
- Use an existing wallet and export the private key
- Create a new wallet using [Phantom](https://phantom.app) or [Solflare](https://solflare.com)
- Fund it with USDC from an exchange

### 3. Configure Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "unreel-video": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/unreel-x402-mcp/index.ts"],
      "env": {
        "SVM_PRIVATE_KEY": "your_base58_solana_private_key"
      }
    }
  }
}
```

### 4. Restart Claude Desktop

Restart Claude Desktop to load the MCP server. Then ask Claude:

> "Generate a video of a sunset over the ocean with gentle waves"

## Available Tools

| Tool | Description | Cost |
|------|-------------|------|
| `generate-video` | Generate a video from a text prompt | ~$25 USDC |
| `check-job-status` | Check video generation progress | Free |
| `get-payment-info` | Get current pricing info | Free |

### generate-video

```typescript
{
  prompt: string,              // Text description of the video
  wait_for_completion?: boolean // Wait for video to finish (default: false)
}
```

### check-job-status

```typescript
{
  job_id: string  // Job ID from generate-video
}
```

## How It Works

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Claude Desktop │────▶│   MCP Server    │────▶│  Unreel AI API  │
│                 │     │  (x402 client)  │     │  (x402 paywall) │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
        │  1. generate-video    │                       │
        │                       │  2. POST /generate    │
        │                       │──────────────────────▶│
        │                       │                       │
        │                       │  3. 402 Payment Req   │
        │                       │◀──────────────────────│
        │                       │                       │
        │                       │  4. Sign USDC payment │
        │                       │                       │
        │                       │  5. Retry + payment   │
        │                       │──────────────────────▶│
        │                       │                       │
        │                       │  6. 202 Accepted      │
        │                       │◀──────────────────────│
        │                       │                       │
        │  7. Return job_id     │                       │
        │◀──────────────────────│                       │
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SVM_PRIVATE_KEY` | Yes | - | Base58-encoded Solana private key |
| `UNREEL_API_URL` | No | `https://x402.unreel.ai` | Unreel API endpoint |

### Using a .env file

```bash
cp .env.example .env
# Edit .env with your private key
```

## Development

```bash
# Run in development mode (with hot reload)
npm run dev

# Build for production
npm run build

# Run production build
npm start
```

## Pricing

| Item | Cost |
|------|------|
| Video generation | ~$25 USDC per video |
| Gas fees | Free (sponsored by Kora) |
| Network | Solana mainnet |

## Security

- **Never commit your private key** to version control
- Use environment variables or a secure secret manager
- The private key is only used for signing USDC transfer transactions
- Consider using a dedicated wallet with limited funds

## Built With

- [x402](https://x402.org) - HTTP 402 payment protocol
- [MCP SDK](https://modelcontextprotocol.io) - Model Context Protocol
- [@x402/axios](https://www.npmjs.com/package/@x402/axios) - Axios wrapper with x402 support
- [@x402/svm](https://www.npmjs.com/package/@x402/svm) - Solana payment scheme

## Related

- [Unreel AI](https://unreel.ai) - AI video generation platform
- [x402 Documentation](https://x402.org) - x402 protocol docs
- [MCP Documentation](https://modelcontextprotocol.io) - Model Context Protocol docs

## License

MIT - see [LICENSE](LICENSE)
