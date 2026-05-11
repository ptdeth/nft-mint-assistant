import assert from "node:assert/strict";
import test from "node:test";

import { parseUnits } from "ethers";

import { mintProjectConfigSchema, MintProjectConfig } from "../src/config/schema.js";
import { assertExecutionApproved, assertGasPriceLimit } from "../src/safety/limits.js";
import { getWalletsForConfig, parseWalletsFromEnv } from "../src/wallets/walletManager.js";

function baseConfig(overrides: Record<string, unknown> = {}): MintProjectConfig {
  return mintProjectConfigSchema.parse({
    projectName: "test-mint",
    sourceUrl: "https://example.com/mint",
    detection: {
      kind: "directMintPage",
      confidence: "medium",
      detectedAt: "2026-05-11T00:00:00.000Z",
      notes: []
    },
    chainId: 8453,
    contractAddress: "0x1234567890123456789012345678901234567890",
    mintFunction: {
      name: "mint",
      args: [],
      quantityArgIndex: 0,
      payable: true,
      abiFragment: "function mint(uint256 quantity) payable"
    },
    quantity: 1,
    priceEth: "0.01",
    approved: false,
    wallets: {
      maxWallets: 1,
      labels: []
    },
    limits: {
      maxMintPriceEth: "0.02",
      maxGasGwei: "2",
      maxTotalSpendEth: "0.03",
      maxAttemptsPerWallet: 1,
      stopAfterSuccess: true,
      perWalletMintLimit: 1
    },
    ...overrides
  });
}

test("config validation refuses invalid contract addresses", () => {
  const result = mintProjectConfigSchema.safeParse({
    ...baseConfig(),
    contractAddress: "not-an-address"
  });

  assert.equal(result.success, false);
  assert.match(JSON.stringify(result.error.issues), /20-byte EVM address/);
});

test("unsupported chain IDs are refused", () => {
  const result = mintProjectConfigSchema.safeParse({
    ...baseConfig(),
    chainId: 10
  });

  assert.equal(result.success, false);
  assert.match(JSON.stringify(result.error.issues), /unsupported chainId/);
});

test("gas price above maxGasGwei is refused", () => {
  const config = baseConfig();

  assert.throws(() => assertGasPriceLimit(config, parseUnits("2.1", "gwei")), /exceeds maxGasGwei 2/);
});

test("missing wallets are refused", () => {
  const originalWallets = process.env.WALLETS;
  delete process.env.WALLETS;

  try {
    assert.throws(() => getWalletsForConfig(baseConfig()), /No wallets configured/);
  } finally {
    if (originalWallets === undefined) {
      delete process.env.WALLETS;
    } else {
      process.env.WALLETS = originalWallets;
    }
  }
});

test("malformed wallet env entries are refused without exposing key material", () => {
  assert.throws(() => parseWalletsFromEnv("wallet1:not-a-key"), /Invalid private key format for wallet label "wallet1"/);
});

test("low-confidence approved analyzer configs are refused by schema", () => {
  const result = mintProjectConfigSchema.safeParse({
    ...baseConfig(),
    approved: true,
    detection: {
      kind: "directMintPage",
      confidence: "low",
      detectedAt: "2026-05-11T00:00:00.000Z",
      notes: ["low confidence test"]
    }
  });

  assert.equal(result.success, false);
  assert.match(JSON.stringify(result.error.issues), /low-confidence detections cannot be approved/);
});

test("execution approval also refuses low-confidence configs if schema is bypassed", () => {
  const unsafeConfig = {
    ...baseConfig(),
    approved: true,
    detection: {
      kind: "directMintPage",
      confidence: "low",
      detectedAt: "2026-05-11T00:00:00.000Z",
      notes: []
    }
  } as MintProjectConfig;

  assert.throws(() => assertExecutionApproved(unsafeConfig), /Low-confidence detections are blocked/);
});
