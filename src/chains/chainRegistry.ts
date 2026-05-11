export type SupportedChainKey = "ethereum" | "base" | "arbitrum";

export interface ChainDefinition {
  key: SupportedChainKey;
  chainId: number;
  name: string;
  nativeCurrency: "ETH";
  rpcEnvVar: string;
  blockExplorerUrl: string;
  openseaChainName: string;
}

export const supportedChains = {
  ethereum: {
    key: "ethereum",
    chainId: 1,
    name: "Ethereum Mainnet",
    nativeCurrency: "ETH",
    rpcEnvVar: "ETHEREUM_RPC_URL",
    blockExplorerUrl: "https://etherscan.io",
    openseaChainName: "ethereum"
  },
  base: {
    key: "base",
    chainId: 8453,
    name: "Base Mainnet",
    nativeCurrency: "ETH",
    rpcEnvVar: "BASE_RPC_URL",
    blockExplorerUrl: "https://basescan.org",
    openseaChainName: "base"
  },
  arbitrum: {
    key: "arbitrum",
    chainId: 42161,
    name: "Arbitrum One",
    nativeCurrency: "ETH",
    rpcEnvVar: "ARBITRUM_RPC_URL",
    blockExplorerUrl: "https://arbiscan.io",
    openseaChainName: "arbitrum"
  }
} satisfies Record<SupportedChainKey, ChainDefinition>;

export function getChainById(chainId: number): ChainDefinition | undefined {
  return Object.values(supportedChains).find((chain) => chain.chainId === chainId);
}

export function supportedChainIds(): number[] {
  return Object.values(supportedChains).map((chain) => chain.chainId);
}

export function supportedChainsSummary(): Array<Pick<ChainDefinition, "chainId" | "name" | "rpcEnvVar">> {
  return Object.values(supportedChains).map(({ chainId, name, rpcEnvVar }) => ({ chainId, name, rpcEnvVar }));
}
