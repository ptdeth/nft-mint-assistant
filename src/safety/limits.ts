import { MintProjectConfig } from "../config/schema.js";
import { formatUnits, parseEther, parseUnits } from "ethers";

export function assertExecutionApproved(config: MintProjectConfig): void {
  if (!config.approved) {
    throw new Error("Config is not approved. Set approved to true only after reviewing a successful dry run.");
  }

  if (config.detection.confidence === "low") {
    throw new Error("Low-confidence detections are blocked from execution.");
  }
}

export function assertDryRunAllowed(config: MintProjectConfig): void {
  if (config.quantity > config.limits.perWalletMintLimit) {
    throw new Error(`Quantity ${config.quantity} exceeds perWalletMintLimit ${config.limits.perWalletMintLimit}.`);
  }

  if (config.wallets.labels.length > config.wallets.maxWallets) {
    throw new Error(`Configured wallet labels exceed maxWallets ${config.wallets.maxWallets}.`);
  }
}

export function assertSpendLimits(config: MintProjectConfig, totalSpendWei?: bigint): void {
  const mintPrice = parseEther(config.priceEth);
  const maxMintPrice = parseEther(config.limits.maxMintPriceEth);
  if (mintPrice > maxMintPrice) {
    throw new Error(`Mint price ${config.priceEth} ETH exceeds maxMintPriceEth ${config.limits.maxMintPriceEth}.`);
  }

  if (totalSpendWei !== undefined) {
    const maxTotalSpend = parseEther(config.limits.maxTotalSpendEth);
    if (totalSpendWei > maxTotalSpend) {
      throw new Error("Estimated total spend exceeds maxTotalSpendEth.");
    }
  }
}

export function assertGasPriceLimit(config: MintProjectConfig, gasPriceWei: bigint): void {
  const maxGasPrice = parseUnits(config.limits.maxGasGwei, "gwei");
  if (gasPriceWei > maxGasPrice) {
    throw new Error(
      `Current gas price ${formatUnits(gasPriceWei, "gwei")} gwei exceeds maxGasGwei ${config.limits.maxGasGwei}.`
    );
  }
}
