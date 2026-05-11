import { extractMintPageHints, MintPageHints } from "./mintPageAnalyzer.js";

export interface OpenSeaCollectionHint {
  slug: string;
  pageUrl: string;
  chainId?: number;
  contractAddress?: string;
  externalUrl?: string;
  mintPageHints?: MintPageHints;
  notes: string[];
}

export function extractOpenSeaSlug(inputUrl: string): string | undefined {
  const url = new URL(inputUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  const collectionIndex = parts.findIndex((part) => part === "collection");
  return collectionIndex >= 0 ? parts[collectionIndex + 1] : undefined;
}

export async function analyzeOpenSeaCollection(inputUrl: string): Promise<OpenSeaCollectionHint> {
  const slug = extractOpenSeaSlug(inputUrl);
  if (!slug) {
    throw new Error("OpenSea URL does not include /collection/<slug>.");
  }

  const pageUrl = `https://opensea.io/collection/${slug}`;
  const notes = [`OpenSea collection slug detected: ${slug}.`];
  let pageText = "";

  try {
    pageText = await fetchText(pageUrl);
  } catch (error) {
    notes.push(`Could not fetch OpenSea page: ${formatError(error)}.`);
  }

  const chainId = pageText ? detectOpenSeaChainId(pageText) : undefined;
  const contractAddress = pageText ? extractFirstContractAddress(pageText) : undefined;
  const externalUrl = pageText ? extractExternalUrl(pageText) : undefined;

  if (chainId) {
    notes.push(`Detected possible chainId ${chainId} from OpenSea page text.`);
  }

  if (contractAddress) {
    notes.push(`Detected possible contract address ${contractAddress} from OpenSea page text.`);
  }

  if (externalUrl) {
    notes.push(`Detected possible external project URL: ${externalUrl}.`);
  }

  let mintPageHints: MintPageHints | undefined;
  if (externalUrl) {
    try {
      const externalText = await fetchText(externalUrl);
      mintPageHints = extractMintPageHints(externalText);
      mintPageHints.sourceUrls = [externalUrl];
      notes.push("Scanned external project URL for mint hints.");
    } catch (error) {
      notes.push(`Could not scan external project URL: ${formatError(error)}.`);
    }
  }

  return {
    slug,
    pageUrl,
    ...(chainId === undefined ? {} : { chainId }),
    ...(contractAddress === undefined ? {} : { contractAddress }),
    ...(externalUrl === undefined ? {} : { externalUrl }),
    ...(mintPageHints === undefined ? {} : { mintPageHints }),
    notes
  };
}

function detectOpenSeaChainId(text: string): number | undefined {
  const normalized = text.toLowerCase();
  const chainPatterns: Array<[RegExp, number]> = [
    [/"chain"\s*:\s*"ethereum"|"chain_identifier"\s*:\s*"ethereum"|\bethereum\b/, 1],
    [/"chain"\s*:\s*"base"|"chain_identifier"\s*:\s*"base"|\bbase\b/, 8453],
    [/"chain"\s*:\s*"arbitrum"|"chain_identifier"\s*:\s*"arbitrum"|\barbitrum\b/, 42161]
  ];

  for (const [pattern, chainId] of chainPatterns) {
    if (pattern.test(normalized)) {
      return chainId;
    }
  }

  return undefined;
}

function extractFirstContractAddress(text: string): string | undefined {
  const match = text.match(/0x[a-fA-F0-9]{40}/);
  return match?.[0];
}

function extractExternalUrl(text: string): string | undefined {
  const decoded = decodeJsonish(text);
  const patterns = [
    /"external_url"\s*:\s*"([^"]+)"/i,
    /"externalUrl"\s*:\s*"([^"]+)"/i,
    /"project_url"\s*:\s*"([^"]+)"/i,
    /"website"\s*:\s*"([^"]+)"/i
  ];

  for (const pattern of patterns) {
    const match = decoded.match(pattern);
    if (match?.[1] && /^https?:\/\//i.test(match[1])) {
      return match[1].replace(/\\u002F/g, "/").replace(/\\\//g, "/");
    }
  }

  return undefined;
}

async function fetchText(inputUrl: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(inputUrl, {
      signal: controller.signal,
      headers: {
        "user-agent": "nft-mint-assistant/0.1 (+safe-analysis; no-automation)"
      }
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function decodeJsonish(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/\\u002F/g, "/").replace(/\\\//g, "/");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
