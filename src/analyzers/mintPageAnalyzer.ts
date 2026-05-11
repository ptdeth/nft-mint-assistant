export interface MintPageHints {
  chainIds: number[];
  contractAddresses: string[];
  abiFragments: string[];
  mintFunctionNames: string[];
  priceCandidatesEth: string[];
  startTimeText?: string;
  startTimeCandidates: string[];
  libraryHints: string[];
  sourceUrls: string[];
}

export const knownMintFunctionNames = ["mint", "publicMint", "claim", "purchase", "mintTo"] as const;

export function emptyMintPageHints(): MintPageHints {
  return {
    chainIds: [],
    contractAddresses: [],
    abiFragments: [],
    mintFunctionNames: [],
    priceCandidatesEth: [],
    startTimeCandidates: [],
    libraryHints: [],
    sourceUrls: []
  };
}

const maxFetchedAssets = 10;
const fetchTimeoutMs = 10_000;

export async function analyzeMintPage(inputUrl: string): Promise<MintPageHints> {
  const html = await fetchText(inputUrl);
  const scriptUrls = extractScriptUrls(inputUrl, html).slice(0, maxFetchedAssets);
  const scriptBodies = await Promise.all(
    scriptUrls.map(async (scriptUrl) => {
      try {
        return await fetchText(scriptUrl);
      } catch {
        return "";
      }
    })
  );

  const combinedText = [html, ...scriptBodies].join("\n");
  const hints = extractMintPageHints(combinedText);
  hints.sourceUrls = [inputUrl, ...scriptUrls];

  return hints;
}

export function extractMintPageHints(text: string): MintPageHints {
  const hints = emptyMintPageHints();

  hints.contractAddresses = unique(Array.from(text.matchAll(/0x[a-fA-F0-9]{40}/g), (match) => match[0]));
  hints.chainIds = uniqueNumbers([
    ...Array.from(text.matchAll(/(?:chainId|chain_id|networkId|network_id)["'\s:=]+(\d{1,8})/gi), (match) =>
      Number(match[1])
    ),
    ...Array.from(text.matchAll(/(?:id|chain)\s*:\s*(1|8453|42161)\b/gi), (match) => Number(match[1])),
    ...detectNamedChains(text)
  ]);
  hints.abiFragments = unique(extractAbiFragments(text));
  hints.mintFunctionNames = unique(extractMintFunctionNames(text, hints.abiFragments));
  hints.priceCandidatesEth = unique(extractPrices(text));
  hints.startTimeCandidates = unique(extractStartTimeCandidates(text));
  if (hints.startTimeCandidates[0]) {
    hints.startTimeText = hints.startTimeCandidates[0];
  }
  hints.libraryHints = unique(extractLibraryHints(text));

  return hints;
}

function extractScriptUrls(inputUrl: string, html: string): string[] {
  const baseUrl = new URL(inputUrl);
  const urls = Array.from(html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi), (match) => match[1])
    .filter((src): src is string => Boolean(src))
    .map((src) => {
      try {
        return new URL(src, baseUrl).toString();
      } catch {
        return undefined;
      }
    })
    .filter((url): url is string => Boolean(url));

  return unique(urls).filter((url) => {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  });
}

function extractAbiFragments(text: string): string[] {
  const fragments = new Set<string>();

  for (const name of knownMintFunctionNames) {
    const escaped = escapeRegExp(name);
    const functionRegex = new RegExp(`function\\s+${escaped}\\s*\\(([^)]*)\\)(?:\\s+[^;"'{}]*)?`, "gi");
    for (const match of text.matchAll(functionRegex)) {
      fragments.add(normalizeAbiFragment(`function ${name}(${match[1] ?? ""}) payable`));
    }

    const jsonRegex = new RegExp(
      String.raw`["']?name["']?\s*:\s*["']${escaped}["'][\s\S]{0,800}?["']?inputs["']?\s*:\s*\[([\s\S]{0,800}?)\]`,
      "gi"
    );
    for (const match of text.matchAll(jsonRegex)) {
      const inputs = match[1] ?? "";
      const types = Array.from(inputs.matchAll(/["']?type["']?\s*:\s*["']([^"']+)["']/gi), (typeMatch) => typeMatch[1]);
      fragments.add(normalizeAbiFragment(`function ${name}(${types.join(",")}) payable`));
    }
  }

  return Array.from(fragments);
}

function extractMintFunctionNames(text: string, abiFragments: string[]): string[] {
  return knownMintFunctionNames.filter((name) => {
    const escaped = escapeRegExp(name);
    const patterns = [
      new RegExp(`function\\s+${escaped}\\s*\\(`, "i"),
      new RegExp(`["']?name["']?\\s*:\\s*["']${escaped}["']`, "i"),
      new RegExp(`\\.${escaped}\\s*\\(`, "i"),
      new RegExp(`writeContract\\s*\\([\\s\\S]{0,500}functionName\\s*:\\s*["']${escaped}["']`, "i"),
      new RegExp(`functionName\\s*:\\s*["']${escaped}["']`, "i")
    ];

    return abiFragments.some((fragment) => fragment.includes(`function ${name}(`)) || patterns.some((pattern) => pattern.test(text));
  });
}

function normalizeAbiFragment(fragment: string): string {
  return fragment.replace(/\s+/g, " ").trim();
}

function extractPrices(text: string): string[] {
  const prices = new Set<string>();

  for (const match of text.matchAll(/(\d+(?:\.\d{1,18})?)\s*(?:ETH|\u039e)/giu)) {
    prices.add(trimDecimal(match[1] ?? "0"));
  }

  for (const match of text.matchAll(/parseEther\s*\(\s*["'](\d+(?:\.\d{1,18})?)["']\s*\)/gi)) {
    prices.add(trimDecimal(match[1] ?? "0"));
  }

  for (const match of text.matchAll(/(?:mintPrice|price|cost|publicPrice|salePrice|mintCost)["'\s:=]+["']?(\d+(?:\.\d{1,18})?)["']?/gi)) {
    const value = trimDecimal(match[1] ?? "0");
    if (Number(value) <= 100) {
      prices.add(value);
    }
  }

  return Array.from(prices);
}

function extractStartTimeCandidates(text: string): string[] {
  const candidates = new Set<string>();
  const normalized = decodeHtml(stripTags(text)).replace(/\s+/g, " ");
  const patterns = [
    /\b(?:mint|sale|public sale|claim)\s+(?:starts|opens|begins)\s+(?:at|on|in)?\s*([^.!?]{4,120})/gi,
    /\b(?:starts|opens|begins)\s+(?:at|on|in)\s*([^.!?]{4,120})/gi,
    /\b(?:countdown|starts in|opening in)\s*[:\-]?\s*([^.!?]{4,120})/gi,
    /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[^"' <]+)/gi,
    /\b(?:mintStart|startTime|saleStart|publicSaleStart|claimStart|opensAt)["'\s:=]+["']?(\d{10,13})["']?/gi,
    /\b(?:mintStart|startTime|saleStart|publicSaleStart|claimStart|opensAt)["'\s:=]+["']([^"']{4,120})["']/gi
  ];

  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      if (match[1]) {
        candidates.add(match[1].trim());
      }
    }
  }

  for (const match of text.matchAll(/(?:Date\.parse|new Date)\s*\(\s*["']([^"']{4,120})["']\s*\)/gi)) {
    if (match[1]) {
      candidates.add(match[1].trim());
    }
  }

  return Array.from(candidates);
}

function extractLibraryHints(text: string): string[] {
  const checks: Array<[string, RegExp]> = [
    ["ethers.js", /\bethers\b|BrowserProvider|JsonRpcProvider|parseEther|getContractAt/i],
    ["wagmi", /\bwagmi\b|createConfig|configureChains|useWriteContract|useContractWrite|writeContract/i],
    ["rainbowkit", /\brainbowkit\b|getDefaultWallets|RainbowKitProvider|connectorsForWallets/i],
    ["web3modal", /\bweb3modal\b|createWeb3Modal|Web3Modal|walletConnectProjectId/i]
  ];

  return checks.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

function detectNamedChains(text: string): number[] {
  const found: number[] = [];
  if (/\bethereum\b|\bmainnet\b/i.test(text)) {
    found.push(1);
  }
  if (/\bbase\b/i.test(text)) {
    found.push(8453);
  }
  if (/\barbitrum(?: one)?\b/i.test(text)) {
    found.push(42161);
  }

  return found;
}

async function fetchText(inputUrl: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);

  try {
    const response = await fetch(inputUrl, {
      signal: controller.signal,
      headers: {
        "user-agent": "nft-mint-assistant/0.1 (+safe-analysis; no-automation)"
      }
    });

    if (!response.ok) {
      throw new Error(`Fetch failed for ${inputUrl}: ${response.status} ${response.statusText}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function stripTags(text: string): string {
  return text.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
}

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function trimDecimal(value: string): string {
  return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function uniqueNumbers(items: number[]): number[] {
  return unique(items.filter((item) => Number.isInteger(item)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
