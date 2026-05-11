import { MintProjectConfig } from "../config/schema.js";

export interface WalletInput {
  label: string;
  privateKey: string;
}

export function parseWalletsFromEnv(value = process.env.WALLETS): WalletInput[] {
  if (!value) {
    return [];
  }

  return value.split(",").map((entry, index) => {
    const [label, privateKey] = entry.split(":");
    if (!label || !privateKey) {
      throw new Error(`Invalid WALLETS entry at position ${index + 1}. Expected label:privateKey.`);
    }

    if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
      throw new Error(`Invalid private key format for wallet label "${label}". Expected a 0x-prefixed 32-byte hex key.`);
    }

    return { label, privateKey };
  });
}

export function getWalletsForConfig(config: MintProjectConfig): WalletInput[] {
  const wallets = parseWalletsFromEnv();
  if (wallets.length === 0) {
    throw new Error("No wallets configured. Add WALLETS to .env using label:privateKey entries.");
  }

  const selected =
    config.wallets.labels.length > 0
      ? wallets.filter((wallet) => config.wallets.labels.includes(wallet.label))
      : wallets.slice(0, config.wallets.maxWallets);

  if (selected.length === 0) {
    throw new Error("No configured wallets match config.wallets.labels.");
  }

  if (selected.length > config.wallets.maxWallets) {
    throw new Error(`Selected wallet count ${selected.length} exceeds maxWallets ${config.wallets.maxWallets}.`);
  }

  const missingLabels = config.wallets.labels.filter((label) => !wallets.some((wallet) => wallet.label === label));
  if (missingLabels.length > 0) {
    throw new Error(`Missing wallet labels in .env: ${missingLabels.join(", ")}`);
  }

  return selected;
}
