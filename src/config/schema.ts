import { z } from "zod";

import { supportedChainIds } from "../chains/chainRegistry.js";

const ethAmountStringSchema = z.string().regex(/^\d+(\.\d+)?$/, "must be a decimal ETH amount string");

const evmAddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "must be a 20-byte EVM address");

const detectionSchema = z.object({
  kind: z.enum(["opensea", "directMintPage"]),
  confidence: z.enum(["high", "medium", "low"]),
  detectedAt: z.string().datetime(),
  notes: z.array(z.string()).default([]),
  candidates: z
    .object({
      chainIds: z.array(z.number().int()).default([]),
      contractAddresses: z.array(evmAddressSchema).default([]),
      abiFragments: z.array(z.string()).default([]),
      mintFunctionNames: z.array(z.enum(["mint", "publicMint", "claim", "purchase", "mintTo"])).default([]),
      priceCandidatesEth: z.array(ethAmountStringSchema).default([]),
      startTimeCandidates: z.array(z.string()).default([]),
      libraryHints: z.array(z.string()).default([]),
      sourceUrls: z.array(z.string().url()).default([])
    })
    .default({
      chainIds: [],
      contractAddresses: [],
      abiFragments: [],
      mintFunctionNames: [],
      priceCandidatesEth: [],
      startTimeCandidates: [],
      libraryHints: [],
      sourceUrls: []
    })
});

const mintFunctionSchema = z.object({
  name: z.enum(["mint", "publicMint", "claim", "purchase", "mintTo"]),
  args: z.array(z.unknown()).default([]),
  quantityArgIndex: z.number().int().nonnegative().optional(),
  payable: z.boolean().default(true),
  abiFragment: z.string().optional()
});

const walletRulesSchema = z.object({
  maxWallets: z.number().int().positive().max(50),
  labels: z.array(z.string().min(1)).default([])
});

const safetyLimitsSchema = z.object({
  maxMintPriceEth: ethAmountStringSchema,
  maxGasGwei: ethAmountStringSchema,
  maxTotalSpendEth: ethAmountStringSchema,
  maxAttemptsPerWallet: z.number().int().positive().max(10),
  stopAfterSuccess: z.boolean(),
  perWalletMintLimit: z.number().int().positive().max(100)
});

export const mintProjectConfigSchema = z
  .object({
    projectName: z.string().min(1),
    sourceUrl: z.string().url(),
    detection: detectionSchema,
    chainId: z.number().int().refine((chainId) => supportedChainIds().includes(chainId), {
      message: "unsupported chainId"
    }),
    contractAddress: evmAddressSchema,
    mintFunction: mintFunctionSchema,
    quantity: z.number().int().positive(),
    priceEth: ethAmountStringSchema,
    approved: z.boolean().default(false),
    wallets: walletRulesSchema,
    limits: safetyLimitsSchema
  })
  .superRefine((config, ctx) => {
    if (config.detection.confidence === "low" && config.approved) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approved"],
        message: "low-confidence detections cannot be approved for execution"
      });
    }

    if (config.quantity > config.limits.perWalletMintLimit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quantity"],
        message: "quantity exceeds perWalletMintLimit"
      });
    }

    if (config.wallets.labels.length > config.wallets.maxWallets) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["wallets", "labels"],
        message: "wallet label count exceeds maxWallets"
      });
    }
  });

export type MintProjectConfig = z.infer<typeof mintProjectConfigSchema>;
