import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { analyzeMintPage, MintPageHints } from "./mintPageAnalyzer.js";
import { analyzeOpenSeaCollection } from "./openseaAnalyzer.js";
import { supportedChainIds } from "../chains/chainRegistry.js";
import { MintProjectConfig, mintProjectConfigSchema } from "../config/schema.js";

export type UrlKind = "opensea" | "directMintPage";
export type DetectionConfidence = "high" | "medium" | "low";
type MintFunctionName = MintProjectConfig["mintFunction"]["name"];

export interface AnalyzeResult {
  url: string;
  kind: UrlKind;
  confidence: DetectionConfidence;
  outputPath?: string;
  config: MintProjectConfig;
  notes: string[];
}

export interface AnalyzeOptions {
  outPath?: string;
  verbose?: boolean;
}

export function detectUrlKind(inputUrl: string): UrlKind {
  const url = new URL(inputUrl);
  return url.hostname.toLowerCase().includes("opensea.io") ? "opensea" : "directMintPage";
}

export async function analyzeMintUrl(inputUrl: string, options: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const kind = detectUrlKind(inputUrl);
  const config = kind === "opensea" ? await configFromOpenSea(inputUrl) : await configFromMintPage(inputUrl);

  const outputPath = options.outPath ?? defaultConfigPath(inputUrl);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  return {
    url: inputUrl,
    kind,
    confidence: config.detection.confidence,
    outputPath,
    config,
    notes: config.detection.notes
  };
}

async function configFromOpenSea(inputUrl: string): Promise<MintProjectConfig> {
  const openSeaHints = await analyzeOpenSeaCollection(inputUrl);
  const mergedHints = mergeHints(openSeaHints.mintPageHints, {
    chainIds: openSeaHints.chainId === undefined ? [] : [openSeaHints.chainId],
    contractAddresses: openSeaHints.contractAddress === undefined ? [] : [openSeaHints.contractAddress],
    abiFragments: [],
    mintFunctionNames: [],
    priceCandidatesEth: [],
    startTimeCandidates: [],
    libraryHints: [],
    sourceUrls: [openSeaHints.pageUrl]
  });

  const notes = [
    ...openSeaHints.notes,
    "OpenSea pages often do not expose primary-sale mint functions. Review all detected fields before approval."
  ];

  return buildConfig({
    inputUrl,
    kind: "opensea",
    hints: mergedHints,
    projectName: openSeaHints.slug,
    notes
  });
}

async function configFromMintPage(inputUrl: string): Promise<MintProjectConfig> {
  const hints = await analyzeMintPage(inputUrl);
  const notes = ["Scanned public page HTML and same-origin script assets for static mint hints."];

  return buildConfig({
    inputUrl,
    kind: "directMintPage",
    hints,
    projectName: projectNameFromUrl(inputUrl),
    notes
  });
}

function buildConfig(input: {
  inputUrl: string;
  kind: UrlKind;
  hints: MintPageHints;
  projectName: string;
  notes: string[];
}): MintProjectConfig {
  const chainId = chooseSupportedChainId(input.hints);
  const contractAddress = input.hints.contractAddresses[0] ?? "0x0000000000000000000000000000000000000000";
  const mintFunctionName = chooseMintFunctionName(input.hints);
  const abiFragment = chooseAbiFragment(input.hints, mintFunctionName);
  const priceEth = input.hints.priceCandidatesEth[0] ?? "0";
  const confidence = scoreConfidence(input.hints, contractAddress, mintFunctionName, priceEth);
  const notes = [...input.notes, ...buildDetectionNotes(input.hints, confidence, chainId, contractAddress, mintFunctionName)];
  const maxGasGwei = chainId === 1 ? "30" : "2";
  const maxTotalSpendEth = priceEth === "0" ? "0.001" : priceEth;

  return mintProjectConfigSchema.parse({
    projectName: input.projectName,
    sourceUrl: input.inputUrl,
    detection: {
      kind: input.kind,
      confidence,
      detectedAt: new Date().toISOString(),
      notes,
      candidates: {
        chainIds: input.hints.chainIds,
        contractAddresses: input.hints.contractAddresses,
        abiFragments: input.hints.abiFragments,
        mintFunctionNames: input.hints.mintFunctionNames,
        priceCandidatesEth: input.hints.priceCandidatesEth,
        startTimeCandidates: input.hints.startTimeCandidates,
        libraryHints: input.hints.libraryHints,
        sourceUrls: input.hints.sourceUrls
      }
    },
    chainId,
    contractAddress,
    mintFunction: {
      name: mintFunctionName,
      args: [],
      quantityArgIndex: 0,
      payable: true,
      ...(abiFragment ? { abiFragment } : {})
    },
    quantity: 1,
    priceEth,
    approved: false,
    wallets: {
      maxWallets: 1,
      labels: []
    },
    limits: {
      maxMintPriceEth: priceEth,
      maxGasGwei,
      maxTotalSpendEth,
      maxAttemptsPerWallet: 1,
      stopAfterSuccess: true,
      perWalletMintLimit: 1
    }
  });
}

function mergeHints(primary: MintPageHints | undefined, secondary: MintPageHints): MintPageHints {
  if (!primary) {
    return secondary;
  }

  return {
    chainIds: uniqueNumbers([...primary.chainIds, ...secondary.chainIds]),
    contractAddresses: unique([...primary.contractAddresses, ...secondary.contractAddresses]),
    abiFragments: unique([...primary.abiFragments, ...secondary.abiFragments]),
    mintFunctionNames: unique([...primary.mintFunctionNames, ...secondary.mintFunctionNames]),
    priceCandidatesEth: unique([...primary.priceCandidatesEth, ...secondary.priceCandidatesEth]),
    startTimeCandidates: unique([...primary.startTimeCandidates, ...secondary.startTimeCandidates]),
    libraryHints: unique([...primary.libraryHints, ...secondary.libraryHints]),
    sourceUrls: unique([...primary.sourceUrls, ...secondary.sourceUrls]),
    ...(primary.startTimeText || secondary.startTimeText
      ? { startTimeText: primary.startTimeText ?? secondary.startTimeText }
      : {})
  };
}

function chooseSupportedChainId(hints: MintPageHints): number {
  return hints.chainIds.find((chainId) => supportedChainIds().includes(chainId)) ?? 8453;
}

function chooseMintFunctionName(hints: MintPageHints): MintFunctionName {
  const name = hints.mintFunctionNames.find((candidate): candidate is MintFunctionName =>
    ["mint", "publicMint", "claim", "purchase", "mintTo"].includes(candidate)
  );

  return name ?? "mint";
}

function chooseAbiFragment(hints: MintPageHints, mintFunctionName: MintFunctionName): string | undefined {
  return hints.abiFragments.find((fragment) => fragment.includes(`function ${mintFunctionName}(`));
}

function scoreConfidence(
  hints: MintPageHints,
  contractAddress: string,
  mintFunctionName: MintFunctionName,
  priceEth: string
): DetectionConfidence {
  const hasContract = contractAddress !== "0x0000000000000000000000000000000000000000";
  const hasSupportedChain = hints.chainIds.some((chainId) => supportedChainIds().includes(chainId));
  const hasMintFunction = isMintFunctionVerified(hints, mintFunctionName);
  const hasPrice = priceEth !== "0";

  if (hasContract && hasSupportedChain && hasMintFunction && hasPrice) {
    return "high";
  }

  if (hasContract && hasSupportedChain && (hasMintFunction || hasPrice)) {
    return hasMintFunction ? "medium" : "low";
  }

  return "low";
}

function isMintFunctionVerified(hints: MintPageHints, mintFunctionName: MintFunctionName): boolean {
  return (
    hints.abiFragments.some((fragment) => fragment.includes(`function ${mintFunctionName}(`)) ||
    hints.mintFunctionNames.includes(mintFunctionName)
  );
}

function buildDetectionNotes(
  hints: MintPageHints,
  confidence: DetectionConfidence,
  chainId: number,
  contractAddress: string,
  mintFunctionName: MintFunctionName
): string[] {
  const notes = [
    `Detected ${hints.contractAddresses.length} contract address candidate(s).`,
    `Detected ${hints.chainIds.length} chain ID candidate(s).`,
    `Selected chainId ${chainId}.`,
    `Selected contract ${contractAddress}.`,
    `Selected mint function ${mintFunctionName}.`,
    `Detected ${hints.priceCandidatesEth.length} ETH price candidate(s).`,
    `Detected library hints: ${hints.libraryHints.length > 0 ? hints.libraryHints.join(", ") : "none"}.`
  ];

  if (hints.startTimeText) {
    notes.push(`Possible start time text: ${hints.startTimeText}.`);
  }

  if (hints.sourceUrls.length > 0) {
    notes.push(`Scanned sources: ${hints.sourceUrls.join(", ")}.`);
  }

  if (confidence === "low") {
    notes.push("Confidence is low. This config is saved for review only and cannot be approved for execution.");
  }

  return notes;
}

function defaultConfigPath(inputUrl: string): string {
  return path.join("mints", `${projectNameFromUrl(inputUrl)}.json`);
}

function projectNameFromUrl(inputUrl: string): string {
  const url = new URL(inputUrl);
  const raw = `${url.hostname}${url.pathname}`.replace(/\/$/, "");
  const safe = raw.replace(/[^a-z0-9-]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  return safe || "mint-project";
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function uniqueNumbers(items: number[]): number[] {
  return unique(items.filter((item) => Number.isInteger(item)));
}
