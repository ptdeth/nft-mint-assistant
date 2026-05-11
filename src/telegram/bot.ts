import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Telegraf } from "telegraf";
import type { Context } from "telegraf";

import { analyzeMintUrl } from "../analyzers/detectorUtils.js";
import { dryRunMintConfig, DryRunSummary, executeMintConfig, MintExecutionSummary } from "../chains/evmExecutor.js";
import { loadMintConfig } from "../config/loadConfig.js";
import { MintProjectConfig, mintProjectConfigSchema } from "../config/schema.js";
import { createLogger } from "../logs/logger.js";

const logger = createLogger("telegram");
const mintsDir = path.resolve("mints");

export function parseAllowedUserIds(value = process.env.TELEGRAM_ALLOWED_USER_IDS): Set<number> {
  if (!value) {
    return new Set();
  }

  return new Set(
    value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const id = Number(part);
        if (!Number.isSafeInteger(id)) {
          throw new Error(`Invalid TELEGRAM_ALLOWED_USER_IDS entry: ${part}`);
        }
        return id;
      })
  );
}

export function isAllowedUser(userId: number | undefined, allowedUserIds: Set<number>): boolean {
  return userId !== undefined && allowedUserIds.has(userId);
}

export function containsSecretLikeText(text: string): boolean {
  return /\b0x[a-fA-F0-9]{64}\b/.test(text) || /private[_\s-]?key|seed phrase|mnemonic/i.test(text);
}

export function redactSecrets(text: string): string {
  return text
    .replace(/\b0x[a-fA-F0-9]{64}\b/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/(TELEGRAM_BOT_TOKEN\s*=\s*)\S+/gi, "$1[REDACTED]")
    .replace(/(WALLETS\s*=\s*)[^\s]+/gi, "$1[REDACTED]");
}

export function resolveConfigPath(configName: string): string {
  const normalized = configName.trim().replace(/\.json$/i, "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(normalized)) {
    throw new Error("Invalid config name. Use only letters, numbers, dots, dashes, and underscores.");
  }

  const resolved = path.resolve(mintsDir, `${normalized}.json`);
  if (!resolved.startsWith(`${mintsDir}${path.sep}`)) {
    throw new Error("Invalid config path.");
  }

  return resolved;
}

export async function approveConfig(configName: string): Promise<MintProjectConfig> {
  const configPath = resolveConfigPath(configName);
  const config = await loadMintConfig(configPath);
  const dryRunSummary = await dryRunMintConfig(config);
  if (!dryRunSummary.canProceedToApproval) {
    throw new Error("Dry run did not pass cleanly. Config was not approved.");
  }

  const approved = mintProjectConfigSchema.parse({
    ...config,
    approved: true
  });
  await writeFile(configPath, `${JSON.stringify(approved, null, 2)}\n`, "utf8");
  return approved;
}

export function formatDryRunForTelegram(summary: DryRunSummary): string {
  const walletLines = summary.wallets.map(
    (wallet) =>
      `- ${wallet.label}: balance ${wallet.balanceEth} ETH, total ${wallet.estimatedTotalCostEth ?? "unavailable"} ETH, static ${wallet.staticCall.ok ? "ok" : "not ok"}`
  );

  return redactSecrets(
    [
      "Dry run summary",
      `Project: ${summary.projectName}`,
      `Chain: ${summary.chain.name} (${summary.chain.chainId})`,
      `Contract: ${summary.contractAddress}`,
      `Function: ${summary.mintFunction}`,
      `Value: ${summary.valueEth} ETH`,
      `Total estimate: ${summary.totals.estimatedTotalSpendEth} ETH`,
      `Can approve: ${summary.canProceedToApproval ? "yes" : "no"}`,
      ...walletLines,
      ...(summary.warnings.length > 0 ? ["Warnings:", ...summary.warnings.map((warning) => `- ${warning}`)] : [])
    ].join("\n")
  );
}

export function formatMintForTelegram(summary: MintExecutionSummary): string {
  return redactSecrets(
    [
      "Mint summary",
      `Project: ${summary.projectName}`,
      `Transactions sent: ${summary.sentCount}`,
      `Successful receipts: ${summary.successCount}`,
      `Stopped because: ${summary.stoppedReason}`,
      `Log: ${summary.logPath}`,
      ...summary.wallets.map((wallet) => `- ${wallet.label}: success ${wallet.success ? "yes" : "no"}, attempts ${wallet.attempts}${wallet.txHash ? `, tx ${wallet.txHash}` : ""}`)
    ].join("\n")
  );
}

export function createTelegramBot(token: string, allowedUserIds = parseAllowedUserIds()): Telegraf {
  if (allowedUserIds.size === 0) {
    throw new Error("TELEGRAM_ALLOWED_USER_IDS is required. Refusing to start an open bot.");
  }

  const bot = new Telegraf(token);

  bot.use(async (ctx, next) => {
    if (!isAllowedUser(ctx.from?.id, allowedUserIds)) {
      logger.warn({ userId: ctx.from?.id }, "blocked unauthorized telegram user");
      return;
    }

    const text = getMessageText(ctx);
    if (text && containsSecretLikeText(text)) {
      await ctx.reply("Refusing to accept private keys or secret material through Telegram. Configure wallets locally in .env.");
      return;
    }

    await next();
  });

  bot.start(async (ctx) => {
    await ctx.reply("NFT mint assistant ready. Use /help for commands. Wallet keys are never accepted through Telegram.");
  });

  bot.help(async (ctx) => {
    await ctx.reply(helpText());
  });

  bot.command("analyze", async (ctx) => {
    await replySafely(ctx, async () => {
      const url = requireArg(ctx, "Usage: /analyze <url>");
      await mkdir(mintsDir, { recursive: true });
      const result = await analyzeMintUrl(url);
      return `Analysis saved: ${result.outputPath}\nConfidence: ${result.confidence}\nApproved: ${result.config.approved ? "yes" : "no"}`;
    });
  });

  bot.command("dryrun", async (ctx) => {
    await replySafely(ctx, async () => {
      const configName = requireArg(ctx, "Usage: /dryrun <configName>");
      const config = await loadMintConfig(resolveConfigPath(configName));
      return formatDryRunForTelegram(await dryRunMintConfig(config));
    });
  });

  bot.command("approve", async (ctx) => {
    await replySafely(ctx, async () => {
      const configName = requireArg(ctx, "Usage: /approve <configName>");
      const config = await approveConfig(configName);
      return `Approved ${config.projectName}. Run /mint ${configName} only if you are ready to send a real transaction.`;
    });
  });

  bot.command("mint", async (ctx) => {
    await replySafely(ctx, async () => {
      const configName = requireArg(ctx, "Usage: /mint <configName>");
      const config = await loadMintConfig(resolveConfigPath(configName));
      if (!config.approved) {
        throw new Error("Config is not approved. Run /dryrun first, then /approve only after reviewing the result.");
      }
      return formatMintForTelegram(await executeMintConfig(config));
    });
  });

  bot.command("status", async (ctx) => {
    await ctx.reply("Bot is running. Configs are stored in ./mints and transaction logs in ./logs.");
  });

  bot.command("limits", async (ctx) => {
    await ctx.reply(
      [
        "Safety limits enforced from each config:",
        "- maxMintPriceEth",
        "- maxGasGwei",
        "- maxTotalSpendEth",
        "- maxAttemptsPerWallet",
        "- stopAfterSuccess",
        "- perWalletMintLimit",
        "- maxWallets"
      ].join("\n")
    );
  });

  return bot;
}

function helpText(): string {
  return [
    "Commands:",
    "/analyze <url> - analyze a mint or OpenSea URL and save config",
    "/dryrun <configName> - validate and simulate without sending",
    "/approve <configName> - approve only after a clean dry run",
    "/mint <configName> - send only if config is approved",
    "/status - bot status",
    "/limits - safety limits",
    "",
    "Never send private keys, seed phrases, or secrets here."
  ].join("\n");
}

function getMessageText(ctx: Context): string | undefined {
  const message = ctx.message;
  return message && "text" in message ? message.text : undefined;
}

function requireArg(ctx: Context, usage: string): string {
  const text = getMessageText(ctx) ?? "";
  const arg = text.split(/\s+/).slice(1).join(" ").trim();
  if (!arg) {
    throw new Error(usage);
  }
  return arg;
}

async function replySafely(ctx: Context, action: () => Promise<string>): Promise<void> {
  try {
    await ctx.reply(redactSecrets(await action()));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(redactSecrets(`Command failed: ${message}`));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required.");
  }

  const bot = createTelegramBot(token);
  await bot.launch();
  logger.info("telegram bot started");

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
