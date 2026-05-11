import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";

import {
  Contract,
  formatEther,
  formatUnits,
  Interface,
  JsonRpcProvider,
  parseEther,
  TransactionReceipt,
  Wallet
} from "ethers";

import { getChainById } from "./chainRegistry.js";
import { MintProjectConfig } from "../config/schema.js";
import { assertDryRunAllowed, assertExecutionApproved, assertGasPriceLimit, assertSpendLimits } from "../safety/limits.js";
import { getWalletsForConfig } from "../wallets/walletManager.js";

export interface WalletDryRunSummary {
  label: string;
  address: string;
  balanceEth: string;
  estimatedGasUnits?: string;
  gasPriceGwei?: string;
  estimatedGasCostEth?: string;
  estimatedTotalCostEth?: string;
  hasSufficientBalance: boolean;
  staticCall: {
    attempted: boolean;
    ok: boolean;
    message: string;
  };
}

export interface DryRunSummary {
  projectName: string;
  sourceUrl: string;
  chain: {
    chainId: number;
    name: string;
    rpcEnvVar: string;
  };
  contractAddress: string;
  mintFunction: string;
  args: unknown[];
  valueEth: string;
  quantity: number;
  approved: boolean;
  confidence: string;
  warnings: string[];
  wallets: WalletDryRunSummary[];
  totals: {
    walletCount: number;
    estimatedTotalSpendEth: string;
  };
  canProceedToApproval: boolean;
}

export interface MintAttemptLog {
  timestamp: string;
  projectName: string;
  chainId: number;
  walletLabel: string;
  walletAddress: string;
  attempt: number;
  status: "prepared" | "sent" | "confirmed" | "failed" | "skipped";
  txHash?: string;
  gasUsed?: string;
  effectiveGasPriceGwei?: string;
  estimatedGasUnits?: string;
  estimatedTotalCostEth?: string;
  error?: string;
}

export interface MintWalletSummary {
  label: string;
  address: string;
  attempts: number;
  success: boolean;
  txHash?: string;
  status?: number;
  gasUsed?: string;
  error?: string;
}

export interface MintExecutionSummary {
  projectName: string;
  chainId: number;
  contractAddress: string;
  logPath: string;
  wallets: MintWalletSummary[];
  sentCount: number;
  successCount: number;
  stoppedReason: string;
}

interface PreparedMintContext {
  provider: JsonRpcProvider;
  chain: {
    chainId: number;
    name: string;
    rpcEnvVar: string;
  };
  wallets: Array<{
    label: string;
    wallet: Wallet;
  }>;
  args: unknown[];
  abiFragment: string;
  calldata: string;
  value: bigint;
  gasPrice: bigint;
}

export async function dryRunMintConfig(config: MintProjectConfig): Promise<DryRunSummary> {
  assertDryRunAllowed(config);

  const prepared = await prepareMintContext(config, "dryrun");

  const walletSummaries: WalletDryRunSummary[] = [];
  let estimatedTotalSpend = 0n;

  for (const { label, wallet } of prepared.wallets) {
    const balance = await prepared.provider.getBalance(wallet.address);
    const txRequest = {
      from: wallet.address,
      to: config.contractAddress,
      data: prepared.calldata,
      value: prepared.value
    };

    let gasEstimate: bigint | undefined;
    let staticCall = {
      attempted: false,
      ok: false,
      message: "Static call was not attempted."
    };

    try {
      gasEstimate = await prepared.provider.estimateGas(txRequest);
    } catch (error) {
      staticCall = {
        attempted: false,
        ok: false,
        message: `Gas estimation failed: ${formatError(error)}`
      };
    }

    if (gasEstimate !== undefined) {
      const contract = new Contract(config.contractAddress, [prepared.abiFragment], wallet);
      try {
        await contract.getFunction(config.mintFunction.name).staticCall(...prepared.args, { value: prepared.value });
        staticCall = {
          attempted: true,
          ok: true,
          message: "Static call succeeded."
        };
      } catch (error) {
        staticCall = {
          attempted: true,
          ok: false,
          message: `Static call reverted or failed: ${formatError(error)}`
        };
      }
    }

    const gasCost = gasEstimate === undefined ? undefined : gasEstimate * prepared.gasPrice;
    const totalCost = gasCost === undefined ? undefined : gasCost + prepared.value;
    if (totalCost !== undefined) {
      estimatedTotalSpend += totalCost;
    }

    const walletSummary: WalletDryRunSummary = {
      label,
      address: wallet.address,
      balanceEth: formatEther(balance),
      hasSufficientBalance: totalCost === undefined ? false : balance >= totalCost,
      staticCall
    };

    if (gasEstimate !== undefined) {
      walletSummary.estimatedGasUnits = gasEstimate.toString();
    }

    walletSummary.gasPriceGwei = formatUnits(prepared.gasPrice, "gwei");

    if (gasCost !== undefined) {
      walletSummary.estimatedGasCostEth = formatEther(gasCost);
    }

    if (totalCost !== undefined) {
      walletSummary.estimatedTotalCostEth = formatEther(totalCost);
    }

    walletSummaries.push(walletSummary);
  }

  assertSpendLimits(config, estimatedTotalSpend);

  const warnings = buildWarnings(config, walletSummaries);

  return {
    projectName: config.projectName,
    sourceUrl: config.sourceUrl,
    chain: prepared.chain,
    contractAddress: config.contractAddress,
    mintFunction: config.mintFunction.name,
    args: prepared.args,
    valueEth: config.priceEth,
    quantity: config.quantity,
    approved: config.approved,
    confidence: config.detection.confidence,
    warnings,
    wallets: walletSummaries,
    totals: {
      walletCount: walletSummaries.length,
      estimatedTotalSpendEth: formatEther(estimatedTotalSpend)
    },
    canProceedToApproval:
      warnings.length === 0 &&
      walletSummaries.length > 0 &&
      walletSummaries.every((wallet) => wallet.hasSufficientBalance && wallet.staticCall.ok)
  };
}

export async function executeMintConfig(config: MintProjectConfig): Promise<MintExecutionSummary> {
  assertExecutionApproved(config);
  assertDryRunAllowed(config);

  const prepared = await prepareMintContext(config, "mint");
  const logPath = await createMintLogPath(config.projectName);
  const walletSummaries: MintWalletSummary[] = [];
  let sentCount = 0;
  let successCount = 0;
  let estimatedTotalSpend = 0n;
  let stoppedReason = "all configured wallets processed";
  let shouldStopAll = false;

  for (const { label, wallet } of prepared.wallets) {
    const walletSummary: MintWalletSummary = {
      label,
      address: wallet.address,
      attempts: 0,
      success: false
    };

    for (let attempt = 1; attempt <= config.limits.maxAttemptsPerWallet; attempt += 1) {
      walletSummary.attempts = attempt;

      let gasEstimate: bigint;
      let totalCost: bigint;

      try {
        const balance = await prepared.provider.getBalance(wallet.address);
        const txRequest = {
          from: wallet.address,
          to: config.contractAddress,
          data: prepared.calldata,
          value: prepared.value
        };

        gasEstimate = await prepared.provider.estimateGas(txRequest);
        totalCost = gasEstimate * prepared.gasPrice + prepared.value;
        assertSpendLimits(config, estimatedTotalSpend + totalCost);

        if (balance < totalCost) {
          throw new Error(`Insufficient balance. Need ${formatEther(totalCost)} ETH, have ${formatEther(balance)} ETH.`);
        }

        const contract = new Contract(config.contractAddress, [prepared.abiFragment], wallet);
        await contract.getFunction(config.mintFunction.name).staticCall(...prepared.args, { value: prepared.value });

        await appendMintLog(logPath, {
          timestamp: new Date().toISOString(),
          projectName: config.projectName,
          chainId: config.chainId,
          walletLabel: label,
          walletAddress: wallet.address,
          attempt,
          status: "prepared",
          estimatedGasUnits: gasEstimate.toString(),
          estimatedTotalCostEth: formatEther(totalCost)
        });

        const tx = await wallet.sendTransaction({
          to: config.contractAddress,
          data: prepared.calldata,
          value: prepared.value,
          gasLimit: gasEstimate,
          gasPrice: prepared.gasPrice
        });
        sentCount += 1;

        await appendMintLog(logPath, {
          timestamp: new Date().toISOString(),
          projectName: config.projectName,
          chainId: config.chainId,
          walletLabel: label,
          walletAddress: wallet.address,
          attempt,
          status: "sent",
          txHash: tx.hash,
          estimatedGasUnits: gasEstimate.toString(),
          estimatedTotalCostEth: formatEther(totalCost)
        });

        const receipt = await tx.wait();
        const receiptSummary = summarizeReceipt(receipt);
        estimatedTotalSpend += receiptSummary.actualCostWei ?? totalCost;
        walletSummary.txHash = tx.hash;
        if (typeof receipt?.status === "number") {
          walletSummary.status = receipt.status;
        }
        if (receiptSummary.gasUsed) {
          walletSummary.gasUsed = receiptSummary.gasUsed;
        }

        if (receipt?.status === 1) {
          successCount += 1;
          walletSummary.success = true;

          const confirmedLog: MintAttemptLog = {
            timestamp: new Date().toISOString(),
            projectName: config.projectName,
            chainId: config.chainId,
            walletLabel: label,
            walletAddress: wallet.address,
            attempt,
            status: "confirmed",
            txHash: tx.hash
          };
          if (receiptSummary.gasUsed) {
            confirmedLog.gasUsed = receiptSummary.gasUsed;
          }
          if (receiptSummary.effectiveGasPriceGwei) {
            confirmedLog.effectiveGasPriceGwei = receiptSummary.effectiveGasPriceGwei;
          }
          await appendMintLog(logPath, confirmedLog);

          if (config.limits.stopAfterSuccess) {
            stoppedReason = "stopAfterSuccess reached";
            break;
          }

          break;
        }

        walletSummary.error = "Transaction receipt status was not successful.";
        const failedReceiptLog: MintAttemptLog = {
          timestamp: new Date().toISOString(),
          projectName: config.projectName,
          chainId: config.chainId,
          walletLabel: label,
          walletAddress: wallet.address,
          attempt,
          status: "failed",
          txHash: tx.hash,
          error: walletSummary.error
        };
        if (receiptSummary.gasUsed) {
          failedReceiptLog.gasUsed = receiptSummary.gasUsed;
        }
        if (receiptSummary.effectiveGasPriceGwei) {
          failedReceiptLog.effectiveGasPriceGwei = receiptSummary.effectiveGasPriceGwei;
        }
        await appendMintLog(logPath, failedReceiptLog);
      } catch (error) {
        const message = formatError(error);
        walletSummary.error = message;
        await appendMintLog(logPath, {
          timestamp: new Date().toISOString(),
          projectName: config.projectName,
          chainId: config.chainId,
          walletLabel: label,
          walletAddress: wallet.address,
          attempt,
          status: "failed",
          error: message
        });

        if (message.includes("Estimated total spend exceeds maxTotalSpendEth")) {
          stoppedReason = "maxTotalSpendEth reached";
          shouldStopAll = true;
          break;
        }
      }

      if (walletSummary.success) {
        break;
      }
    }

    if (!walletSummary.success && walletSummary.attempts >= config.limits.maxAttemptsPerWallet) {
      await appendMintLog(logPath, {
        timestamp: new Date().toISOString(),
        projectName: config.projectName,
        chainId: config.chainId,
        walletLabel: label,
        walletAddress: wallet.address,
        attempt: walletSummary.attempts,
        status: "skipped",
        error: "Max attempts reached for wallet."
      });
    }

    walletSummaries.push(walletSummary);

    if (config.limits.stopAfterSuccess && successCount > 0) {
      break;
    }

    if (shouldStopAll) {
      break;
    }
  }

  return {
    projectName: config.projectName,
    chainId: config.chainId,
    contractAddress: config.contractAddress,
    logPath,
    wallets: walletSummaries,
    sentCount,
    successCount,
    stoppedReason
  };
}

async function prepareMintContext(config: MintProjectConfig, mode: "dryrun" | "mint"): Promise<PreparedMintContext> {
  const chain = getChainById(config.chainId);
  if (!chain) {
    throw new Error(`Unsupported chainId: ${config.chainId}`);
  }

  const rpcUrl = process.env[chain.rpcEnvVar];
  if (!rpcUrl) {
    throw new Error(`Missing ${chain.rpcEnvVar}. Add it to .env before running ${mode}.`);
  }

  const provider = new JsonRpcProvider(rpcUrl, config.chainId);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== config.chainId) {
    throw new Error(`RPC chain mismatch. Config chainId is ${config.chainId}, but RPC returned ${network.chainId}.`);
  }

  const walletInputs = getWalletsForConfig(config);
  const wallets = walletInputs.map((walletInput) => ({
    label: walletInput.label,
    wallet: new Wallet(walletInput.privateKey, provider)
  }));

  const value = parseEther(config.priceEth);
  assertSpendLimits(config, value);

  const args = buildMintArgs(config);
  const abiFragment = getAbiFragment(config);
  const contractInterface = new Interface([abiFragment]);
  const calldata = contractInterface.encodeFunctionData(config.mintFunction.name, args);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
  if (!gasPrice) {
    throw new Error("RPC did not return gas price or max fee data.");
  }

  assertGasPriceLimit(config, gasPrice);

  return {
    provider,
    chain: {
      chainId: chain.chainId,
      name: chain.name,
      rpcEnvVar: chain.rpcEnvVar
    },
    wallets,
    args,
    abiFragment,
    calldata,
    value,
    gasPrice
  };
}

function buildMintArgs(config: MintProjectConfig): unknown[] {
  const args = [...config.mintFunction.args];
  if (config.mintFunction.quantityArgIndex !== undefined) {
    args[config.mintFunction.quantityArgIndex] = config.quantity;
  }

  return args;
}

function getAbiFragment(config: MintProjectConfig): string {
  if (config.mintFunction.abiFragment) {
    return config.mintFunction.abiFragment;
  }

  if (config.mintFunction.quantityArgIndex === undefined || config.mintFunction.quantityArgIndex !== 0) {
    throw new Error("mintFunction.abiFragment is required when the quantity argument is not the first argument.");
  }

  return `function ${config.mintFunction.name}(uint256 quantity) payable`;
}

function buildWarnings(config: MintProjectConfig, walletSummaries: WalletDryRunSummary[]): string[] {
  const warnings: string[] = [];

  if (config.detection.confidence === "low") {
    warnings.push("Detection confidence is low. This config cannot be approved for mint execution.");
  }

  for (const wallet of walletSummaries) {
    if (!wallet.hasSufficientBalance) {
      warnings.push(`${wallet.label} does not have enough balance for the estimated total cost.`);
    }

    if (!wallet.staticCall.ok) {
      warnings.push(`${wallet.label}: ${wallet.staticCall.message}`);
    }
  }

  return warnings;
}

async function createMintLogPath(projectName: string): Promise<string> {
  const logsDir = path.resolve("logs");
  await mkdir(logsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeProjectName = projectName.replace(/[^a-z0-9-]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  return path.join(logsDir, `${safeProjectName || "mint"}-${timestamp}.jsonl`);
}

async function appendMintLog(logPath: string, event: MintAttemptLog): Promise<void> {
  await appendFile(logPath, `${JSON.stringify(event)}\n`, "utf8");
}

function summarizeReceipt(receipt: TransactionReceipt | null): {
  gasUsed?: string;
  effectiveGasPriceGwei?: string;
  actualCostWei?: bigint;
} {
  if (!receipt) {
    return {};
  }

  const gasUsed = receipt.gasUsed;
  const effectiveGasPrice = receipt.gasPrice;
  return {
    gasUsed: gasUsed.toString(),
    effectiveGasPriceGwei: formatUnits(effectiveGasPrice, "gwei"),
    actualCostWei: gasUsed * effectiveGasPrice
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const ethersError = error as Error & {
      shortMessage?: string;
      reason?: string;
      code?: string;
      info?: {
        error?: {
          message?: string;
        };
      };
    };

    const message = ethersError.shortMessage ?? ethersError.reason ?? ethersError.info?.error?.message;
    if (message) {
      return ethersError.code ? `${message} (${ethersError.code})` : message;
    }

    return error.message;
  }

  return String(error);
}
